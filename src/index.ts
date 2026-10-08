import { createHash, createHmac, timingSafeEqual, randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import nodemailer from 'nodemailer';

export type Channel = 'app' | 'email';
export interface Identity { service: string; userId: string; email?: string; name?: string; info?: Record<string, unknown> }
export interface MediaInput { base64:string; mimeType:string; fileName:string }
export interface MessageInput extends Identity { channel: Channel; text: string; requestId?: string; subject?: string; webhookUrl?: string; attachments?:MediaInput[] }
export interface Config {
  databaseUrl: string; botToken: string; adminChatId: number; telegramSecret: string;
  serviceKeys: Record<string, string>; webhookOrigins?: Record<string, string>; inboundEmailSecret?: string;
  smtp?: { host: string; port: number; user: string; password: string; from: string };
}
export function constantTimeEqual(a: string, b: string): boolean {
  const x = createHash('sha256').update(a).digest();
  const y = createHash('sha256').update(b).digest();
  return timingSafeEqual(x, y);
}
export function assertIdentifier(value: string, max = 128): string {
  if (!value || value.length > max || /[\x00-\x1f]/.test(value)) throw new Error('invalid identifier');
  return value;
}
export function topicName(service: string, userId: string, name?: string): string {
  return `${service} · ${name || userId}`.slice(0, 128);
}
export function validateWebhookUrl(value: string, origin: string): string {
  const url = new URL(value);
  const expected = new URL(origin);
  if (url.protocol !== 'https:' || expected.protocol !== 'https:' || url.origin !== expected.origin || url.username || url.password || url.hash) throw new Error('webhook URL is not allowed');
  return url.href;
}
export interface ReplyEvent { id:string; service:string; userId:string; threadId:string; channel:'app'; text:string; telegramMessageId:number; attachment?:MediaInput }
export class SupportClient {
  constructor(private readonly baseUrl:string,private readonly service:string,private readonly key:string) {
    if(new URL(baseUrl).protocol!=='https:') throw new Error('support API must use HTTPS');
  }
  async send(input:Omit<MessageInput,'service'|'channel'>):Promise<{id:string;threadId:string}> {
    return this.request('POST','/v1/messages',{...input,service:this.service});
  }
  async history(userId:string,before?:string):Promise<{messages:any[]}> {
    const query=new URLSearchParams({service:this.service,userId});if(before) query.set('before',before);
    return this.request('GET',`/v1/messages?${query}`);
  }
  private async request(method:string,path:string,data?:unknown):Promise<any> {
    const response=await fetch(new URL(path,this.baseUrl),{method,headers:{authorization:`Bearer ${this.key}`,'content-type':'application/json'},body:data?JSON.stringify(data):undefined,signal:AbortSignal.timeout(30000)});
    if(!response.ok) throw new Error(`support API failed: ${response.status}`);
    return response.json();
  }
}
export function verifyReplyWebhook(rawBody:string,timestamp:string,signature:string,key:string,nowSeconds=Math.floor(Date.now()/1000)):ReplyEvent {
  const seconds=Number(timestamp);
  if(!Number.isSafeInteger(seconds)||Math.abs(nowSeconds-seconds)>300) throw new Error('expired support webhook');
  const expected=`sha256=${createHmac('sha256',key).update(`${timestamp}.${rawBody}`).digest('hex')}`;
  if(!constantTimeEqual(signature,expected)) throw new Error('invalid support webhook signature');
  const data=JSON.parse(rawBody) as ReplyEvent;
  if(!data.id?.startsWith('telegram:')||!data.service||!data.userId||!data.threadId||data.channel!=='app'||typeof data.text!=='string'||!Number.isSafeInteger(data.telegramMessageId)) throw new Error('invalid support webhook payload');
  return data;
}
export class SupportBot {
  readonly pool: Pool;
  private readonly mailer;
  constructor(readonly config: Config) {
    if (!config.databaseUrl || !config.botToken || !Number.isSafeInteger(config.adminChatId) || config.adminChatId <= 0 || config.telegramSecret.length < 16) throw new Error('invalid configuration');
    this.pool = new Pool({ connectionString: config.databaseUrl, max: 10 });
    this.mailer = config.smtp ? nodemailer.createTransport({ host: config.smtp.host, port: config.smtp.port, secure: config.smtp.port === 465, auth: { user: config.smtp.user, pass: config.smtp.password } }) : undefined;
  }
  async close(): Promise<void> { await this.pool.end(); }
  async migrate(): Promise<void> {
    await this.pool.query(`CREATE TABLE IF NOT EXISTS support_threads (
      id uuid PRIMARY KEY, service text NOT NULL, user_id text NOT NULL, email text, name text,
      info jsonb NOT NULL DEFAULT '{}', webhook_url text, telegram_topic_id bigint UNIQUE, intro_message_id bigint,
      created_at timestamptz NOT NULL DEFAULT now(), UNIQUE(service,user_id)
    );
    CREATE TABLE IF NOT EXISTS support_messages (
      id uuid PRIMARY KEY, thread_id uuid NOT NULL REFERENCES support_threads(id),
      sender text NOT NULL CHECK(sender IN ('user','support')), channel text NOT NULL CHECK(channel IN ('app','email')),
      body text NOT NULL, subject text, telegram_message_id bigint, telegram_update_id bigint UNIQUE,
      email_message_id text UNIQUE, created_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS support_messages_history ON support_messages(thread_id,created_at,id);
    ALTER TABLE support_threads ADD COLUMN IF NOT EXISTS webhook_url text;`);
  }
  async telegram(method: string, data: Record<string, unknown>): Promise<any> {
    const response = await fetch(`https://api.telegram.org/bot${this.config.botToken}/${method}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(data), signal: AbortSignal.timeout(30000) });
    const result: any = await response.json();
    if (!response.ok || !result.ok) throw new Error(`Telegram ${method} failed: ${result.error_code || response.status}`);
    return result.result;
  }
  private async sendMedia(topic:number,threadId:string,file:MediaInput,caption?:string):Promise<number> {
    if(!/^(image\/(jpeg|png|heic)|video\/(mp4|quicktime))$/.test(file.mimeType)||!file.base64||file.base64.length>68_000_000||!file.fileName||file.fileName.length>100) throw new Error('invalid attachment');
    const bytes=Buffer.from(file.base64,'base64');if(!bytes.length||bytes.length>48*1024*1024) throw new Error('attachment too large');
    const kind=file.mimeType.startsWith('image/')?'photo':file.mimeType==='video/mp4'?'video':'document';
    const form=new FormData();form.set('chat_id',String(this.config.adminChatId));form.set('message_thread_id',String(topic));
    form.set('reply_markup',JSON.stringify({inline_keyboard:[[{text:'Info',callback_data:`info:${threadId}`}]]}));
    if(caption) form.set('caption',caption);
    form.set(kind,new Blob([bytes],{type:file.mimeType}),file.fileName);
    const response=await fetch(`https://api.telegram.org/bot${this.config.botToken}/send${kind[0].toUpperCase()}${kind.slice(1)}`,{method:'POST',body:form,signal:AbortSignal.timeout(60000)});
    const result:any=await response.json();if(!response.ok||!result.ok) throw new Error(`Telegram media failed: ${result.error_code||response.status}`);
    return result.result.message_id;
  }
  private async download(fileId:string):Promise<Buffer> {
    const info=await this.telegram('getFile',{file_id:fileId});
    if(!info.file_path||info.file_path.startsWith('/')||info.file_path.includes('..')||info.file_size>48*1024*1024) throw new Error('invalid Telegram file');
    const response=await fetch(`https://api.telegram.org/file/bot${this.config.botToken}/${info.file_path}`,{signal:AbortSignal.timeout(60000)});
    if(!response.ok) throw new Error('Telegram download failed');const bytes=Buffer.from(await response.arrayBuffer());
    if(!bytes.length||bytes.length>48*1024*1024) throw new Error('invalid Telegram file size');return bytes;
  }
  private infoText(row: any): string {
    const details = Object.entries(row.info || {}).map(([k, v]) => `${k}: ${typeof v === 'string' ? v : JSON.stringify(v)}`).join('\n');
    return `Сервис: ${row.service}\nПользователь: ${row.user_id}\nИмя: ${row.name || '—'}\nEmail: ${row.email || '—'}${details ? `\n${details}` : ''}`.slice(0, 3500);
  }
  async send(input: MessageInput): Promise<{ id: string; threadId: string }> {
    assertIdentifier(input.service, 80); assertIdentifier(input.userId);
    if (!['app','email'].includes(input.channel) || (!input.text.trim()&&!input.attachments?.length) || input.text.length > 10000|| (input.attachments?.length||0)>4) throw new Error('invalid message');
    if (input.email && (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(input.email) || input.email.length > 254)) throw new Error('invalid email');
    const webhookUrl = input.webhookUrl ? validateWebhookUrl(input.webhookUrl,this.config.webhookOrigins?.[input.service] || '') : null;
    const id = input.requestId || randomUUID();
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [`${input.service}:${input.userId}`]);
      let row = (await client.query('SELECT * FROM support_threads WHERE service=$1 AND user_id=$2', [input.service,input.userId])).rows[0];
      if (!row) {
        const threadId = randomUUID();
        const topic = await this.telegram('createForumTopic', { chat_id: this.config.adminChatId, name: topicName(input.service,input.userId,input.name) });
        row = (await client.query('INSERT INTO support_threads(id,service,user_id,email,name,info,webhook_url,telegram_topic_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *', [threadId,input.service,input.userId,input.email || null,input.name || null,input.info || {},webhookUrl,topic.message_thread_id])).rows[0];
      } else {
        row = (await client.query('UPDATE support_threads SET email=COALESCE($2,email),name=COALESCE($3,name),info=CASE WHEN $4::jsonb = \'{}\'::jsonb THEN info ELSE $4::jsonb END,webhook_url=COALESCE($5,webhook_url) WHERE id=$1 RETURNING *', [row.id,input.email || null,input.name || null,JSON.stringify(input.info || {}),webhookUrl])).rows[0];
      }
      if (!row.intro_message_id) {
        const intro = await this.telegram('sendMessage', { chat_id:this.config.adminChatId,message_thread_id:row.telegram_topic_id,text:this.infoText(row),reply_markup:{inline_keyboard:[[{text:'Info',callback_data:`info:${row.id}`}]]} });
        await client.query('UPDATE support_threads SET intro_message_id=$2 WHERE id=$1',[row.id,intro.message_id]);
      }
      const existing = (await client.query('SELECT id FROM support_messages WHERE id=$1 AND thread_id=$2',[id,row.id])).rows[0];
      if (existing) { await client.query('COMMIT'); return { id, threadId:row.id }; }
      const heading = `${input.service} · ${input.channel === 'email' ? 'Email' : 'Приложение'}`;
      const caption=`${heading}\n\n${input.text}`;
      const sent = input.attachments?.length
        ? {message_id:await this.sendMedia(row.telegram_topic_id,row.id,input.attachments[0],caption.slice(0,1000))}
        : await this.telegram('sendMessage',{chat_id:this.config.adminChatId,message_thread_id:row.telegram_topic_id,text:caption.slice(0,4096),reply_markup:{inline_keyboard:[[{text:'Info',callback_data:`info:${row.id}`}]]}});
      for(const file of input.attachments?.slice(1)||[]) await this.sendMedia(row.telegram_topic_id,row.id,file);
      if(input.attachments?.length&&caption.length>1000) await this.telegram('sendMessage',{chat_id:this.config.adminChatId,message_thread_id:row.telegram_topic_id,text:caption.slice(1000,5096),reply_markup:{inline_keyboard:[[{text:'Info',callback_data:`info:${row.id}`}]]}});
      await client.query('INSERT INTO support_messages(id,thread_id,sender,channel,body,subject,telegram_message_id) VALUES($1,$2,$3,$4,$5,$6,$7)',[id,row.id,'user',input.channel,input.text,input.subject || null,sent.message_id]);
      await client.query('COMMIT'); return { id,threadId:row.id };
    } catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
  }
  async history(service: string,userId: string,before?: string): Promise<any[]> {
    const result = await this.pool.query(`SELECT m.id,m.sender,m.channel,m.body,m.subject,m.created_at FROM support_messages m JOIN support_threads t ON t.id=m.thread_id WHERE t.service=$1 AND t.user_id=$2 AND ($3::uuid IS NULL OR (m.created_at,m.id)<(SELECT created_at,id FROM support_messages WHERE id=$3 AND thread_id=t.id)) ORDER BY m.created_at DESC,m.id DESC LIMIT 100`,[service,userId,before || null]);
    return result.rows.reverse();
  }
  async receiveTelegram(update: any): Promise<void> {
    if (update.callback_query) {
      const callback = update.callback_query;
      if (callback.from?.id !== this.config.adminChatId || callback.message?.chat?.id !== this.config.adminChatId) return;
      const callbackData=typeof callback.data==='string'?callback.data:'';
      const threadId=/^info:[0-9a-f-]{36}$/.test(callbackData)?callbackData.slice(5):null;
      const legacyUserId=/^support_info:[0-9a-f-]{36}$/.test(callbackData)?callbackData.slice(13):null;
      if (threadId||legacyUserId) {
        const row = (await this.pool.query('SELECT * FROM support_threads WHERE (id=$1::uuid OR (service=$2 AND user_id=$3)) AND telegram_topic_id=$4',[threadId,'PaulIsLavaTV',legacyUserId,callback.message.message_thread_id])).rows[0];
        if (row) await this.telegram('sendMessage',{chat_id:this.config.adminChatId,message_thread_id:row.telegram_topic_id,text:this.infoText(row)});
      }
      await this.telegram('answerCallbackQuery',{callback_query_id:callback.id}); return;
    }
    const message = update.message;
    if (!message || message.chat?.id !== this.config.adminChatId || message.from?.id !== this.config.adminChatId || !message.message_thread_id || !(message.text||message.caption||message.photo||message.video)) return;
    const text=message.text||message.caption||'';
    const media=message.photo?.length ? {file_id:message.photo.at(-1).file_id,mimeType:'image/jpeg',fileName:'photo.jpg'} : message.video ? {file_id:message.video.file_id,mimeType:message.video.mime_type||'video/mp4',fileName:message.video.file_name||'video.mp4'} : null;
    const attachment=media?{base64:(await this.download(media.file_id)).toString('base64'),mimeType:media.mimeType,fileName:media.fileName}:undefined;
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const thread = (await client.query('SELECT * FROM support_threads WHERE telegram_topic_id=$1 FOR UPDATE',[message.message_thread_id])).rows[0];
      if (!thread) { await client.query('ROLLBACK'); return; }
      const existing = (await client.query('SELECT 1 FROM support_messages WHERE telegram_update_id=$1',[update.update_id])).rowCount;
      if (existing) { await client.query('COMMIT'); return; }
      const last = (await client.query("SELECT channel,subject FROM support_messages WHERE thread_id=$1 AND sender='user' ORDER BY created_at DESC LIMIT 1",[thread.id])).rows[0];
      const channel: Channel = last?.channel || 'app';
      if (channel === 'email') {
        if (!thread.email || !this.mailer || !this.config.smtp) throw new Error('email delivery unavailable');
        await this.mailer.sendMail({ from:this.config.smtp.from,to:thread.email,subject:`Re: ${last.subject || `${thread.service} support`}`,text,attachments:attachment?[{filename:attachment.fileName,content:Buffer.from(attachment.base64,'base64'),contentType:attachment.mimeType}]:undefined,headers:{'X-Support-Thread':thread.id} });
      }
      if (channel === 'app' && thread.webhook_url) {
        const origin=this.config.webhookOrigins?.[thread.service];
        const key=this.config.serviceKeys[thread.service];
        if (!origin || !key) throw new Error('webhook configuration unavailable');
        const destination=validateWebhookUrl(thread.webhook_url,origin);
        const payload=JSON.stringify({id:`telegram:${update.update_id}`,service:thread.service,userId:thread.user_id,threadId:thread.id,channel:'app',text,telegramMessageId:message.message_id,attachment});
        const timestamp=Math.floor(Date.now()/1000).toString();
        const signature=createHmac('sha256',key).update(`${timestamp}.${payload}`).digest('hex');
        const response=await fetch(destination,{method:'POST',headers:{'content-type':'application/json','x-support-timestamp':timestamp,'x-support-signature':`sha256=${signature}`},body:payload,redirect:'error',signal:AbortSignal.timeout(10000)});
        if(!response.ok) throw new Error(`support webhook failed: ${response.status}`);
      }
      await client.query('INSERT INTO support_messages(id,thread_id,sender,channel,body,telegram_message_id,telegram_update_id) VALUES($1,$2,$3,$4,$5,$6,$7)',[randomUUID(),thread.id,'support',channel,text,message.message_id,update.update_id]);
      await client.query('COMMIT');
    } catch(error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
  }
}
