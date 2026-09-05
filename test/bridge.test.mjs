import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { WebSocket } from 'ws'
import { createBridgeServer } from '../bridge/server.mjs'

async function fixture(t) {
  const dataRoot = await mkdtemp(join(tmpdir(), 'foundry-bridge-'))
  const server = createBridgeServer({ port: 0, host: '127.0.0.1', ownerKey: 'owner-test-key', dataRoot, logger: { log() {}, error() {} } })
  const address = await server.listen(); t.after(() => server.close())
  return { server, http: `http://127.0.0.1:${address.port}`, ws: `ws://127.0.0.1:${address.port}/ws` }
}
async function api(url, options={}) { const response=await fetch(url,options); return {response,body:await response.json()} }
async function setup(t) {
  const f=await fixture(t)
  const created=await api(`${f.http}/api/v2/campaigns`,{method:'POST',headers:{authorization:'Bearer owner-test-key','content-type':'application/json'},body:JSON.stringify({name:'Test'})})
  const {campaignId,foundryCredential,inviteUrl}=created.body; const invite=new URL(inviteUrl).searchParams.get('invite')
  await api(`${f.http}/api/v2/campaigns/${campaignId}/characters`,{method:'PUT',headers:{authorization:`Bearer ${foundryCredential}`,'content-type':'application/json'},body:JSON.stringify({actorId:'actor-1',tokenId:'token-1',name:'Mira',pin:'1234'})})
  const joined=await api(`${f.http}/api/v2/auth/join`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({invite,actorId:'actor-1',pin:'1234',name:'Player'})})
  return {...f,campaignId,foundryCredential,invite,sessionToken:joined.body.sessionToken}
}
function connect(url,payload){return new Promise((resolve,reject)=>{const ws=new WebSocket(url);ws.inbox=[];ws.on('message',raw=>{const m=JSON.parse(String(raw));ws.inbox.push(m);if(m.type==='connection.welcome')ws.send(JSON.stringify({v:2,kind:'hello',type:'connection.hello',payload}));if(m.type==='connection.ready')resolve(ws);if(m.type==='connection.error')reject(new Error(m.payload.code))});ws.on('error',reject)})}
function next(ws,predicate,timeout=1000){const found=ws.inbox.find(predicate);if(found)return Promise.resolve(found);return new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('timeout')),timeout);ws.on('message',function listener(raw){const m=JSON.parse(String(raw));if(predicate(m)){clearTimeout(timer);ws.off('message',listener);resolve(m)}})})}

test('creates a campaign and never returns PIN hashes',async t=>{const f=await setup(t);const listed=await api(`${f.http}/api/v2/campaigns/${f.campaignId}`,{headers:{authorization:`Bearer ${f.foundryCredential}`}});assert.equal(listed.response.status,200);assert.equal(listed.body.campaign.characters[0].name,'Mira');assert.equal('pinHash' in listed.body.campaign.characters[0],false)})
test('rejects invalid invites and PINs',async t=>{const f=await setup(t);const bad=await api(`${f.http}/api/v2/auth/join`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({invite:f.invite,actorId:'actor-1',pin:'9999'})});assert.equal(bad.response.status,401);assert.equal(bad.body.error.code,'INVALID_PIN')})
test('routes authenticated commands with authoritative actor identity',async t=>{const f=await setup(t);const foundry=await connect(f.ws,{role:'foundry',campaignId:f.campaignId,credential:f.foundryCredential});const player=await connect(f.ws,{role:'player',campaignId:f.campaignId,sessionToken:f.sessionToken});player.send(JSON.stringify({v:2,kind:'command',type:'movement.request',id:'m1',idempotencyKey:'once',payload:{destination:{x:2,y:3}}}));const command=await next(foundry,m=>m.id==='m1');assert.equal(command.source.actorId,'actor-1');assert.equal(command.source.tokenId,'token-1');foundry.send(JSON.stringify({v:2,kind:'response',type:'movement.request.result',replyTo:'m1',payload:{ok:true}}));assert.equal((await next(player,m=>m.replyTo==='m1')).payload.ok,true);foundry.close();player.close()})
test('revocation closes active player sessions',async t=>{const f=await setup(t);const player=await connect(f.ws,{role:'player',campaignId:f.campaignId,sessionToken:f.sessionToken});const closed=new Promise(resolve=>player.once('close',resolve));await api(`${f.http}/api/v2/campaigns/${f.campaignId}/sessions`,{method:'DELETE',headers:{authorization:`Bearer ${f.foundryCredential}`,'content-type':'application/json'},body:JSON.stringify({actorId:'actor-1'})});await closed;await assert.rejects(connect(f.ws,{role:'player',campaignId:f.campaignId,sessionToken:f.sessionToken}),/AUTH_FAILED/)})
test('requires idempotency keys and rejects gameplay while Foundry is offline',async t=>{const f=await setup(t);const player=await connect(f.ws,{role:'player',campaignId:f.campaignId,sessionToken:f.sessionToken});player.send(JSON.stringify({v:2,kind:'command',type:'movement.request',id:'m1',payload:{}}));assert.equal((await next(player,m=>m.type==='connection.error')).payload.code,'INVALID_MESSAGE');player.send(JSON.stringify({v:2,kind:'command',type:'movement.request',id:'m2',idempotencyKey:'k',payload:{}}));assert.equal((await next(player,m=>m.replyTo==='m2')).payload.code,'FOUNDRY_OFFLINE');player.close()})

test('open mode lets a player select a character without invite, PIN, or secret',async t=>{
  const f=await fixture(t)
  const foundry=await connect(f.ws,{role:'foundry',campaignId:'friends'})
  foundry.send(JSON.stringify({v:2,kind:'event',type:'world.snapshot',payload:{revision:1,playableCharacters:[{actorId:'a1',tokenId:'t1',name:'Mira'}],entities:[]}}))
  await new Promise(resolve=>setTimeout(resolve,20))
  const list=await api(`${f.http}/api/v2/open/friends/characters`)
  assert.equal(list.body.characters[0].name,'Mira')
  const selected=await api(`${f.http}/api/v2/open/friends/select`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({actorId:'a1',name:'Arash'})})
  assert.equal(selected.response.status,201)
  const player=await connect(f.ws,{role:'player',campaignId:'friends',sessionToken:selected.body.sessionToken})
  assert.equal(player.inbox.find(message=>message.type==='connection.ready').payload.role,'player')
  foundry.close();player.close()
})

test('open mode permits Foundry CORS asset uploads and authenticated player reads',async t=>{
  const f=await fixture(t),foundry=await connect(f.ws,{role:'foundry',campaignId:'assets'})
  foundry.send(JSON.stringify({v:2,kind:'event',type:'world.snapshot',payload:{revision:1,playableCharacters:[{actorId:'a1',tokenId:'t1',name:'Mira'}]}}));await new Promise(resolve=>setTimeout(resolve,20))
  const selected=await api(`${f.http}/api/v2/open/assets/select`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({actorId:'a1'})})
  const bytes=Buffer.from('image-bytes'),hash=createHash('sha256').update(bytes).digest('hex').slice(0,32),url=`${f.http}/api/v2/campaigns/assets/assets/${hash}`
  const preflight=await fetch(url,{method:'OPTIONS',headers:{origin:'http://foundry.local','access-control-request-method':'PUT','access-control-request-headers':'authorization,content-type'}})
  assert.equal(preflight.status,204);assert.equal(preflight.headers.get('access-control-allow-origin'),'*')
  const uploaded=await fetch(url,{method:'PUT',headers:{origin:'http://foundry.local','content-type':'image/png'},body:bytes});assert.equal(uploaded.status,201)
  const downloaded=await fetch(`${url}?session=${encodeURIComponent(selected.body.sessionToken)}`);assert.equal(downloaded.status,200);assert.deepEqual(Buffer.from(await downloaded.arrayBuffer()),bytes)
  foundry.close()
})

test('Foundry is notified when a player disconnects so the live table cannot retain ghosts',async t=>{
  const f=await setup(t),foundry=await connect(f.ws,{role:'foundry',campaignId:f.campaignId,credential:f.foundryCredential}),player=await connect(f.ws,{role:'player',campaignId:f.campaignId,sessionToken:f.sessionToken})
  const connected=await next(foundry,message=>message.type==='client.connected')
  player.close()
  const disconnected=await next(foundry,message=>message.type==='client.disconnected')
  assert.equal(disconnected.payload.connectionId,connected.payload.connectionId)
  assert.equal(disconnected.payload.tokenId,'token-1')
  foundry.close()
})

test('scoped chat and action events reach only their bridge audience',async t=>{
  const f=await setup(t)
  const foundry=await connect(f.ws,{role:'foundry',campaignId:f.campaignId,credential:f.foundryCredential})
  const first=await connect(f.ws,{role:'player',campaignId:f.campaignId,sessionToken:f.sessionToken})
  const second=await connect(f.ws,{role:'player',campaignId:f.campaignId,sessionToken:f.sessionToken})
  const firstId=first.inbox.find(message=>message.type==='connection.ready').payload.connectionId
  foundry.send(JSON.stringify({v:2,kind:'event',type:'chat.message',audience:{connectionIds:[firstId]},payload:{channel:'npc',text:'Only first'}}))
  assert.equal((await next(first,message=>message.type==='chat.message')).payload.text,'Only first')
  await assert.rejects(next(second,message=>message.type==='chat.message',120),/timeout/)
  foundry.send(JSON.stringify({v:2,kind:'event',type:'action.result',payload:{channel:'party',action:'Longsword'}}))
  assert.equal((await next(first,message=>message.type==='action.result')).payload.action,'Longsword')
  assert.equal((await next(second,message=>message.type==='action.result')).payload.action,'Longsword')
  foundry.close();first.close();second.close()
})
