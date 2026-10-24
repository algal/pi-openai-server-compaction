import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';
import {dirname,resolve} from 'node:path';
const root=resolve(dirname(fileURLToPath(import.meta.url)), '..');
const require=createRequire(root+'/package.json');
const {WebSocketServer}=require('ws');
const {createOpenAIWebSocketStreamFn,releaseAllWsSessions}=await import(root+'/src/openai-ws-stream.ts');
const {applyPayloadPatch}=await import(root+'/src/openai.ts');
const {loadConfig}=await import(root+'/src/config.ts');
const model={id:'gpt-6-luna',provider:'openai',api:'openai-responses',baseUrl:'https://api.openai.com/v1',reasoning:true,input:['text'],contextWindow:272000,maxTokens:128000,cost:{input:0,output:0,cacheRead:0,cacheWrite:0}};
process.env.PI_OPENAI_SERVER_COMPACTION_ENABLED='1';
process.env.PI_OPENAI_SERVER_COMPACTION_PREVIOUS_RESPONSE_ID='1';
let failures=0;
async function check(name,fn){try{await fn();console.log('PASS '+name)}catch(e){failures++;console.log('FAIL '+name+': '+e.message)}}
await check('preserve explicit no-store',()=>assert.equal(applyPayloadPatch({payload:{input:[],store:false},model,cfg:loadConfig('/tmp')}).store,false));
const probe={name:'probe',description:'Probe',parameters:{type:'object',properties:{}}};
const userMessage={role:'user',content:[{type:'text',text:'test'}],timestamp:1};
const legacyContext={systemPrompt:'Legacy guard',tools:[probe],messages:[userMessage]};
async function roundTrip(events,verify,context=legacyContext,api=undefined){
 const server=new WebSocketServer({port:0});await new Promise(r=>server.on('listening',r));let request;
 server.on('connection',ws=>ws.on('message',raw=>{request=JSON.parse(raw);for(const event of events)ws.send(JSON.stringify(event));}));
 try{
 const stream=createOpenAIWebSocketStreamFn({url:`ws://127.0.0.1:${server.address().port}`,maxRetries:0},api)(model,context,{apiKey:'test-only',sessionId:crypto.randomUUID(),transport:'websocket',signal:AbortSignal.timeout(5000)});
 const result=await stream.result();await verify(result,request);
 }finally{releaseAllWsSessions();for(const ws of server.clients)ws.terminate();await new Promise(r=>server.close(r));}
}
const item={id:'msg_test',type:'message',role:'assistant',content:[{type:'output_text',text:'OK'}]};
await check('default storage remains enabled when unspecified',()=>assert.equal(applyPayloadPatch({payload:{input:[]},model,cfg:loadConfig('/tmp')}).store,true));
const done=output=>({type:'response.completed',response:{id:'resp_test',object:'response',status:'completed',output}});
await check('retain streamed items when completed output is empty',()=>roundTrip([{type:'response.output_item.done',output_index:0,item},done([])],r=>assert.equal(r.content[0]?.text,'OK')));
await check('retain tool calls',()=>roundTrip([{type:'response.output_item.done',output_index:0,item:{id:'fc_test',type:'function_call',call_id:'call_test',name:'probe',arguments:'{}'}},done([])],r=>{assert.equal(r.stopReason,'toolUse');assert.equal(r.content[0]?.name,'probe')}));
await check('avoid duplicate full completion items',()=>roundTrip([{type:'response.output_item.done',output_index:0,item},done([item])],r=>assert.equal(r.content.length,1)));
function assertContextPayload(request,prompt,tools){
 assert.equal(request.instructions,prompt);
 assert.deepEqual(request.tools,tools.map(tool=>({type:'function',...tool})));
 assert.deepEqual(request.input,[{type:'message',role:'user',content:'test'}]);
}
await check('retain legacy SDK prompt and tools',()=>roundTrip([done([item])],(r,q)=>assertContextPayload(q,'Legacy guard',[probe])));
await check('adapt Pi 1.x normalized transcript prompt and tools',async()=>{
 const transcript={messages:[userMessage]};
 const normalized={messages:[{role:'system',content:'System guard',toolsAdded:[probe],timestamp:0},userMessage]};
 const calls=[];
 const api={
  normalizeContext(context){assert.equal(context,transcript);calls.push('normalize');return normalized},
  getCurrentSystemPrompt(messages){assert.equal(messages,normalized.messages);calls.push('prompt');return messages[0].content},
  getCurrentTools(messages){assert.equal(messages,normalized.messages);calls.push('tools');return messages[0].toolsAdded},
 };
 await roundTrip([done([item])],(r,q)=>assertContextPayload(q,'System guard',[probe]),transcript,api);
 assert.deepEqual(calls,['normalize','prompt','tools']);
});
await check('surface nested backend errors',()=>roundTrip([{type:'error',error:{type:'invalid_request_error',message:'Store must be set to false'}}],r=>assert.match(r.errorMessage,/Store must be set to false/)));
process.exitCode=failures?1:0;
