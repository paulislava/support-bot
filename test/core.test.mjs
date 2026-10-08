import { test } from 'node:test';
import { createHmac } from 'node:crypto';
import { strict as assert } from 'node:assert';
import { constantTimeEqual, assertIdentifier, topicName, validateWebhookUrl, verifyReplyWebhook, SupportClient, splitTelegramText, messageId } from '../dist/index.js';

test('authentication compares full secret',()=>{assert.equal(constantTimeEqual('abc','abc'),true);assert.equal(constantTimeEqual('abc','abcd'),false);});
test('service and user identifiers reject controls',()=>{assert.throws(()=>assertIdentifier('a\nb'));assert.equal(assertIdentifier('PaulIsLavaTV'),'PaulIsLavaTV');});
test('Telegram topic name stays within limit',()=>{assert.ok(topicName('service','id','x'.repeat(300)).length<=128);});
test('webhook URL is limited to configured HTTPS origin',()=>{assert.equal(validateWebhookUrl('https://tv.paulislava.space/api/support/reply','https://tv.paulislava.space'),'https://tv.paulislava.space/api/support/reply');assert.throws(()=>validateWebhookUrl('https://evil.example/reply','https://tv.paulislava.space'));assert.throws(()=>validateWebhookUrl('http://tv.paulislava.space/reply','https://tv.paulislava.space'));});
test('reply receiver verifies signature and age',()=>{const data={id:'telegram:42',service:'tv',userId:'u',threadId:'t',channel:'app',text:'hi',telegramMessageId:5};const raw=JSON.stringify(data);const key='secret';const ts='1000';const sig=`sha256=${createHmac('sha256',key).update(`${ts}.${raw}`).digest('hex')}`;assert.deepEqual(verifyReplyWebhook(raw,ts,sig,key,1000),data);assert.throws(()=>verifyReplyWebhook(raw,ts,sig,key,1301));assert.throws(()=>verifyReplyWebhook(raw,ts,sig,'bad',1000));});
test('client keeps reverse proxy path prefix',async()=>{const original=globalThis.fetch;let called;globalThis.fetch=async url=>{called=String(url);return new Response(JSON.stringify({messages:[]}),{status:200})};try{await new SupportClient('https://example.com/support-bot','tv','key').history('user');assert.match(called,/\/support-bot\/v1\/messages\?/)}finally{globalThis.fetch=original}});
test('long Unicode messages are split without loss',()=>{const body='📺'.repeat(2600);const parts=splitTelegramText(body,1024);assert.ok(parts.every(p=>p.length<=1024));assert.equal(parts.join(''),body)});
test('email identifiers map to stable UUIDs',()=>{const id=messageId('<mail@example.com>','tv');assert.match(id,/^[0-9a-f-]{36}$/);assert.equal(messageId('<mail@example.com>','tv'),id)});
