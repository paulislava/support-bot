#!/usr/bin/env node
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { SupportBot, constantTimeEqual, type Config } from './index.js';

function loadConfig(): Config {
  const serviceKeys = JSON.parse(process.env.SERVICE_KEYS_JSON || '{}') as Record<string,string>;
  if (!Object.keys(serviceKeys).length || Object.values(serviceKeys).some(key => key.length < 24)) throw new Error('SERVICE_KEYS_JSON requires strong keys');
  return {
    databaseUrl:process.env.DATABASE_URL || '',botToken:process.env.TELEGRAM_BOT_TOKEN || '',adminChatId:Number(process.env.TELEGRAM_ADMIN_CHAT_ID),telegramSecret:process.env.TELEGRAM_WEBHOOK_SECRET || '',serviceKeys,webhookOrigins:JSON.parse(process.env.SERVICE_WEBHOOK_ORIGINS_JSON || '{}'),inboundEmailSecret:process.env.INBOUND_EMAIL_SECRET,
    smtp:process.env.SMTP_HOST && process.env.SMTP_FROM ? {host:process.env.SMTP_HOST,port:Number(process.env.SMTP_PORT || 587),user:process.env.SMTP_USER || '',password:process.env.SMTP_PASSWORD || '',from:process.env.SMTP_FROM} : undefined
  };
}
function respond(res: ServerResponse,status: number,data: unknown): void {
  res.writeHead(status,{'content-type':'application/json; charset=utf-8','cache-control':'no-store'});res.end(JSON.stringify(data));
}
async function body(req: IncomingMessage): Promise<any> {
  const chunks: Buffer[]=[]; let size=0;
  for await (const chunk of req) { size+=chunk.length; if(size>270*1024*1024) throw new Error('body too large'); chunks.push(chunk); }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}
export async function start(): Promise<void> {
  const config=loadConfig();const bot=new SupportBot(config);await bot.migrate();
  const server=createServer(async(req,res)=>{
    try {
      const url=new URL(req.url || '/',`http://${req.headers.host || 'localhost'}`);
      if(url.pathname==='/health' && req.method==='GET') { respond(res,200,{ok:true});return; }
      if(url.pathname==='/v1/telegram/webhook' && req.method==='POST') {
        if(!constantTimeEqual(String(req.headers['x-telegram-bot-api-secret-token'] || ''),config.telegramSecret)) {respond(res,401,{error:'unauthorized'});return;}
        await bot.receiveTelegram(await body(req));respond(res,200,{ok:true});return;
      }
      if(url.pathname==='/v1/email/inbound' && req.method==='POST') {
        if(!config.inboundEmailSecret || !constantTimeEqual(String(req.headers['x-support-email-secret'] || ''),config.inboundEmailSecret)) {respond(res,401,{error:'unauthorized'});return;}
        const data=await body(req);
        if(!config.serviceKeys[data.service]) {respond(res,400,{error:'unknown service'});return;}
        const result=await bot.send({service:data.service,userId:data.userId || data.from,email:data.from,name:data.name,info:data.info,channel:'email',text:data.text,subject:data.subject,requestId:data.id});
        respond(res,201,result);return;
      }
      if(url.pathname==='/v1/messages' && ['GET','POST'].includes(req.method || '')) {
        const data=req.method==='POST' ? await body(req) : {service:url.searchParams.get('service'),userId:url.searchParams.get('userId'),before:url.searchParams.get('before')};
        const service=String(data.service || '');const key=config.serviceKeys[service];
        if(!key || !constantTimeEqual(String(req.headers.authorization || '').replace(/^Bearer /,''),key)) {respond(res,401,{error:'unauthorized'});return;}
        if(!data.userId || typeof data.userId!=='string') {respond(res,400,{error:'userId required'});return;}
        if(req.method==='POST') {respond(res,201,await bot.send({...data,service,channel:'app'}));return;}
        respond(res,200,{messages:await bot.history(service,data.userId,data.before || undefined)});return;
      }
      respond(res,404,{error:'not found'});
    } catch(error) { console.error(error instanceof Error ? error.message : 'request failed'); respond(res,error instanceof SyntaxError ? 400 : 500,{error:'request failed'}); }
  });
  server.listen(Number(process.env.PORT || 8787),'127.0.0.1',()=>console.log('support-bot listening'));
  process.on('SIGTERM',()=>server.close(()=>void bot.close()));
}
if(process.argv[1]?.endsWith('server.js')) start().catch(error=>{console.error(error);process.exitCode=1;});
