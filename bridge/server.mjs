import { createHash, randomUUID } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { dirname, extname, join, normalize, sep } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { WebSocket, WebSocketServer } from 'ws'
import { envelope, PLAYER_COMMANDS, PROTOCOL_VERSION, validateEnvelope } from './protocol.mjs'
import { hashPin, safeEqualSecret, token, tokenHash, verifyPin } from './security.mjs'
import { BridgeStore } from './store.mjs'

export { PROTOCOL_VERSION } from './protocol.mjs'
export const ALLOWED_PLAYER_COMMANDS = PLAYER_COMMANDS
const HERE = dirname(fileURLToPath(import.meta.url)); const MAX_FRAME = 2e6; const MAX_ASSET = 25e6
const roots = [normalize(join(HERE, '..', 'client', 'dist')), normalize(join(HERE, '..', 'client'))]
const mime = { '.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.json':'application/json','.webmanifest':'application/manifest+json','.png':'image/png','.webp':'image/webp','.svg':'image/svg+xml' }
const reply = (res, status, body) => { res.writeHead(status, {'content-type':'application/json; charset=utf-8','cache-control':'no-store'}); res.end(JSON.stringify(body)) }
const fail = (res, status, code, message) => reply(res,status,{ok:false,error:{code,message}})
const send = (ws,msg) => { if(ws?.readyState===WebSocket.OPEN) ws.send(JSON.stringify(msg)) }
const bearer = req => String(req.headers.authorization||'').match(/^Bearer (.+)$/i)?.[1]||''
const clean = (v,d='') => String(v||d).trim().slice(0,80)
async function body(req,max=65536){const out=[];let size=0;for await(const c of req){size+=c.length;if(size>max)throw Object.assign(new Error('Payload too large'),{code:'PAYLOAD_TOO_LARGE'});out.push(c)}return Buffer.concat(out)}
async function jsonBody(req){try{return JSON.parse(String(await body(req))||'{}')}catch{throw Object.assign(new Error('Invalid JSON'),{code:'INVALID_JSON'})}}
async function exists(p){try{await stat(p);return true}catch{return false}}

export function createBridgeServer(options={}) {
  const port=Number(options.port??process.env.BRIDGE_PORT??3847), host=options.host??process.env.BRIDGE_HOST??'0.0.0.0'
  const ownerKey=options.ownerKey??process.env.BRIDGE_OWNER_KEY??options.secret??process.env.BRIDGE_SECRET??''
  const accessMode=options.accessMode??process.env.BRIDGE_ACCESS_MODE??'open'
  const dataRoot=normalize(options.dataRoot??process.env.BRIDGE_DATA_DIR??join(HERE,'data'))
  const origin=String(options.publicOrigin??process.env.BRIDGE_PUBLIC_ORIGIN??'').replace(/\/$/,'')
  const allowed=new Set(String(options.allowedOrigins??process.env.BRIDGE_ALLOWED_ORIGINS??origin).split(',').filter(Boolean))
  const logger=options.logger??console, store=new BridgeStore(dataRoot), ready=store.load(), rooms=new Map(), rates=new Map()
  const room=id=>{if(!rooms.has(id))rooms.set(id,{foundry:null,clients:new Set(),pending:new Map(),replays:new Map(),latestSnapshot:store.data.campaigns[id]?.latestSnapshot||null});return rooms.get(id)}
  const campaign=id=>{const c=store.data.campaigns[id];return c&&!c.closedAt?c:null}
  const authorized=(raw,hash)=>!!raw&&safeEqualSecret(raw,hash)
  const session=(raw,id)=>{const s=store.data.sessions[tokenHash(raw)];return s&&s.campaignId===id&&!s.revokedAt&&s.expiresAt>Date.now()?s:null}
  const wsError=(ws,code,message,id)=>send(ws,envelope('system','connection.error',{code,message},id?{replyTo:id}:{}))
  const status=r=>({foundryConnected:r.foundry?.readyState===WebSocket.OPEN,players:r.clients.size})
  const publishStatus=r=>{for(const ws of r.clients)send(ws,envelope('system','room.status',status(r)))}
  const publicOrigin=req=>origin||`${req.headers['x-forwarded-proto']||'http'}://${req.headers.host}`
  const rateOk=ip=>{const now=Date.now(),e=rates.get(ip)||{at:now,n:0};if(now-e.at>60000){e.at=now;e.n=0}e.n++;rates.set(ip,e);return e.n<121}

  const httpServer=createServer(async(req,res)=>{
    await ready
    const requestOrigin=String(req.headers.origin||'')
    const corsOrigin=accessMode==='open'?'*':(allowed.has(requestOrigin)?requestOrigin:'')
    if(corsOrigin){res.setHeader('access-control-allow-origin',corsOrigin);res.setHeader('access-control-allow-methods','GET,HEAD,POST,PUT,DELETE,OPTIONS');res.setHeader('access-control-allow-headers','authorization,content-type');res.setHeader('access-control-max-age','86400')}
    if(req.method==='OPTIONS'){res.writeHead(corsOrigin?204:403);return res.end()}
    res.setHeader('x-content-type-options','nosniff');res.setHeader('referrer-policy','no-referrer');res.setHeader('content-security-policy',"default-src 'self'; connect-src 'self' ws: wss:; img-src 'self' data: blob:; style-src 'self' 'unsafe-inline'; script-src 'self'")
    if(!rateOk(req.socket.remoteAddress))return fail(res,429,'RATE_LIMITED','Too many requests')
    const url=new URL(req.url||'/',`http://${req.headers.host||'localhost'}`)
    try {
      if(url.pathname==='/health')return reply(res,200,{ok:true,protocolVersion:2,uptime:process.uptime()})
      if(url.pathname==='/ready')return reply(res,200,{ok:true,storage:true,accessMode})
      const openMatch=url.pathname.match(/^\/api\/v2\/open\/([a-zA-Z0-9_-]{1,64})\/(characters|select)$/)
      if(openMatch&&accessMode==='open'){
        const [,id,action]=openMatch,r=room(id),characters=r.latestSnapshot?.payload?.scene?.map?.enabled===false?[]:(r.latestSnapshot?.payload?.playableCharacters||[])
        if(action==='characters'&&req.method==='GET')return reply(res,200,{ok:true,campaignId:id,foundryConnected:!!r.foundry,characters:characters.map(({claimedByConnectionId,...character})=>({...character,available:!claimedByConnectionId}))})
        if(action==='select'&&req.method==='POST'){const x=await jsonBody(req),chosen=characters.find(ch=>ch.actorId===clean(x.actorId)&&!ch.claimedByConnectionId);if(!chosen)return fail(res,409,'CHARACTER_UNAVAILABLE','Character is unavailable');const raw=token(32),expiresAt=Date.now()+2592e6;store.data.sessions[tokenHash(raw)]={campaignId:id,actorId:chosen.actorId,tokenId:chosen.tokenId,name:clean(x.name,chosen.name),createdAt:Date.now(),expiresAt,revokedAt:null};await store.save();return reply(res,201,{ok:true,sessionToken:raw,campaignId:id,actorId:chosen.actorId,tokenId:chosen.tokenId,name:clean(x.name,chosen.name),expiresAt})}
      }
      if(req.method==='POST'&&url.pathname==='/api/v2/campaigns'){
        if(!authorized(bearer(req),tokenHash(ownerKey)))return fail(res,401,'AUTH_FAILED','Invalid owner credential')
        const input=await jsonBody(req),id=token(18),invite=token(24),credential=token(32)
        store.data.campaigns[id]={id,name:clean(input.name,'Campaign'),worldId:clean(input.worldId),inviteHash:tokenHash(invite),foundryCredentialHash:tokenHash(credential),characters:{},assets:{},createdAt:Date.now(),closedAt:null};await store.save()
        return reply(res,201,{ok:true,campaignId:id,foundryCredential:credential,inviteUrl:`${publicOrigin(req)}/?invite=${encodeURIComponent(`${id}.${invite}`)}`})
      }
      const cm=url.pathname.match(/^\/api\/v2\/campaigns\/([^/]+)(?:\/(characters|invite|sessions|close))?$/)
      if(cm){const c=campaign(cm[1]);if(!c)return fail(res,404,'CAMPAIGN_NOT_FOUND','Campaign not found');if(!authorized(bearer(req),c.foundryCredentialHash))return fail(res,401,'AUTH_FAILED','Invalid Foundry credential');const action=cm[2]
        if(req.method==='GET'&&!action)return reply(res,200,{ok:true,campaign:{id:c.id,name:c.name,characters:Object.values(c.characters).map(({pinHash,...x})=>x)}})
        if(req.method==='PUT'&&action==='characters'){const x=await jsonBody(req),actorId=clean(x.actorId);if(!actorId)return fail(res,400,'INVALID_ACTOR','actorId required');c.characters[actorId]={actorId,tokenId:clean(x.tokenId),name:clean(x.name,'Character'),pinHash:await hashPin(x.pin),updatedAt:Date.now()};for(const s of Object.values(store.data.sessions))if(s.campaignId===c.id&&s.actorId===actorId)s.revokedAt=Date.now();await store.save();return reply(res,200,{ok:true,actorId})}
        if(req.method==='POST'&&action==='invite'){const invite=token(24);c.inviteHash=tokenHash(invite);await store.save();return reply(res,200,{ok:true,inviteUrl:`${publicOrigin(req)}/?invite=${encodeURIComponent(`${c.id}.${invite}`)}`})}
        if(req.method==='DELETE'&&action==='sessions'){const x=await jsonBody(req);let revoked=0;for(const s of Object.values(store.data.sessions))if(s.campaignId===c.id&&(!x.actorId||s.actorId===x.actorId)){s.revokedAt=Date.now();revoked++}await store.save();for(const ws of room(c.id).clients)if(!x.actorId||ws.meta.actorId===x.actorId)ws.close(4003,'Revoked');return reply(res,200,{ok:true,revoked})}
        if(req.method==='POST'&&action==='close'){c.closedAt=Date.now();await store.save();const r=room(c.id);r.foundry?.close(4004,'Closed');for(const ws of r.clients)ws.close(4004,'Closed');return reply(res,200,{ok:true})}
        return fail(res,405,'METHOD_NOT_ALLOWED','Unsupported operation')
      }
      if(req.method==='POST'&&url.pathname==='/api/v2/auth/invite'){const x=await jsonBody(req),[id,key]=String(x.invite||'').split('.'),c=campaign(id);if(!c||!authorized(key,c.inviteHash))return fail(res,401,'INVALID_INVITE','Invite invalid or expired');return reply(res,200,{ok:true,campaign:{id,name:c.name},characters:Object.values(c.characters).map(({pinHash,...v})=>v)})}
      if(req.method==='POST'&&url.pathname==='/api/v2/auth/join'){const x=await jsonBody(req),[id,key]=String(x.invite||'').split('.'),c=campaign(id),ch=c?.characters?.[clean(x.actorId)];if(!c||!authorized(key,c.inviteHash))return fail(res,401,'INVALID_INVITE','Invite invalid or expired');if(!ch||!await verifyPin(x.pin,ch.pinHash))return fail(res,401,'INVALID_PIN','Character or PIN invalid');const raw=token(32),expiresAt=Date.now()+2592e6;store.data.sessions[tokenHash(raw)]={campaignId:id,actorId:ch.actorId,tokenId:ch.tokenId,name:clean(x.name,ch.name),createdAt:Date.now(),expiresAt,revokedAt:null};await store.save();return reply(res,201,{ok:true,sessionToken:raw,campaignId:id,actorId:ch.actorId,tokenId:ch.tokenId,name:clean(x.name,ch.name),expiresAt})}
      const am=url.pathname.match(/^\/api\/v2\/campaigns\/([^/]+)\/assets\/([a-f0-9]{32,64})$/)
      if(am){const [,id,hash]=am,c=campaign(id);if(!c)return fail(res,404,'NOT_FOUND','Not found');const path=store.assetPath(id,hash)
        if(req.method==='PUT'){if(accessMode!=='open'&&!authorized(bearer(req),c.foundryCredentialHash))return fail(res,401,'AUTH_FAILED','Invalid credential');const bytes=await body(req,MAX_ASSET),digest=createHash('sha256').update(bytes).digest('hex');if(!digest.startsWith(hash))return fail(res,400,'HASH_MISMATCH','Hash mismatch');await mkdir(dirname(path),{recursive:true});await writeFile(path,bytes);c.assets[hash]={contentType:req.headers['content-type']||'application/octet-stream',bytes:bytes.length};await store.save();return reply(res,201,{ok:true,hash,bytes:bytes.length})}
        if(req.method==='GET'){if(!session(url.searchParams.get('session'),id))return fail(res,401,'AUTH_FAILED','Valid session required');if(!c.assets[hash]||!await exists(path))return fail(res,404,'NOT_FOUND','Not found');res.writeHead(200,{'content-type':c.assets[hash].contentType,'cache-control':'private, max-age=31536000, immutable'});return createReadStream(path).pipe(res)}
      }
      if(!['GET','HEAD'].includes(req.method))return fail(res,405,'METHOD_NOT_ALLOWED','Method not allowed')
      const relative=(url.pathname==='/'?'index.html':url.pathname.replace(/^\/client\/?/,'').replace(/^\//,''))||'index.html'
      const ordered=await exists(join(roots[0],'index.html'))?roots:[roots[1],roots[0]]
      for(const root of ordered){const path=normalize(join(root,relative));if(path!==root&&!path.startsWith(`${root}${sep}`))return fail(res,403,'FORBIDDEN','Forbidden');try{const bytes=await readFile(path);res.writeHead(200,{'content-type':mime[extname(path)]||'application/octet-stream','cache-control':relative==='index.html'?'no-cache':'public, max-age=3600'});return res.end(req.method==='HEAD'?undefined:bytes)}catch{}}
      return fail(res,404,'NOT_FOUND','Not found')
    } catch(error){logger.error?.('[bridge] request failed',error);return fail(res,error.code==='PAYLOAD_TOO_LARGE'?413:400,error.code||'REQUEST_FAILED',error.message)}
  })

  const wss=new WebSocketServer({noServer:true,maxPayload:MAX_FRAME})
  httpServer.on('upgrade',(req,socket,head)=>{const url=new URL(req.url||'/',`http://${req.headers.host}`),o=req.headers.origin;if(url.pathname!=='/ws'||(allowed.size&&o&&!allowed.has(o)))return socket.destroy();wss.handleUpgrade(req,socket,head,ws=>wss.emit('connection',ws))})
  wss.on('connection',ws=>{ws.isAlive=true;ws.meta={id:randomUUID(),role:null,campaignId:null};send(ws,envelope('system','connection.welcome',{protocolVersion:2}));ws.on('pong',()=>ws.isAlive=true)
    ws.on('message',async data=>{await ready;let message;try{if(Buffer.byteLength(data)>MAX_FRAME)throw Error();message=JSON.parse(String(data))}catch{return wsError(ws,'INVALID_JSON','Invalid frame')}const invalid=validateEnvelope(message,{hello:!ws.meta.role});if(invalid)return wsError(ws,'INVALID_MESSAGE',invalid,message?.id)
      if(!ws.meta.role){const p=message.payload,id=clean(p.campaignId,'default');let c=campaign(id);if(!c&&accessMode==='open'&&p.role==='foundry'){c=store.data.campaigns[id]={id,name:id,worldId:'',inviteHash:'',foundryCredentialHash:'',characters:{},assets:{},createdAt:Date.now(),closedAt:null};void store.save()}if(!c){wsError(ws,'CAMPAIGN_NOT_FOUND','Campaign not found');return ws.close(4004)}let identity;if(p.role==='foundry'&&(accessMode==='open'||authorized(p.credential,c.foundryCredentialHash)))identity={role:'foundry',name:'GM'};if(p.role==='player'){const s=session(p.sessionToken,c.id);if(s)identity={role:'player',...s}}if(!identity){wsError(ws,'AUTH_FAILED','Invalid credential');return ws.close(4003)}const r=room(c.id);ws.meta={...ws.meta,...identity,campaignId:c.id};if(identity.role==='foundry'){r.foundry?.close(4012,'Replaced');r.foundry=ws}else{r.clients.add(ws);if(r.foundry)send(r.foundry,envelope('event','client.connected',{connectionId:ws.meta.id,actorId:ws.meta.actorId,tokenId:ws.meta.tokenId,name:ws.meta.name}))}send(ws,envelope('system','connection.ready',{connectionId:ws.meta.id,role:identity.role,campaignId:c.id,...status(r)}));if(identity.role==='player'&&r.latestSnapshot)send(ws,r.latestSnapshot);publishStatus(r);return}
      const r=room(ws.meta.campaignId);if(ws.meta.role==='player'){if(message.kind!=='command'||!PLAYER_COMMANDS.has(message.type))return wsError(ws,'UNSUPPORTED_COMMAND','Unsupported command',message.id);const replayKey=message.idempotencyKey&&`${ws.meta.actorId}:${message.idempotencyKey}`;if(replayKey&&r.replays.has(replayKey))return send(ws,r.replays.get(replayKey));if(!r.foundry||r.foundry.readyState!==WebSocket.OPEN)return wsError(ws,'FOUNDRY_OFFLINE','Foundry is offline; gameplay is read-only',message.id);r.pending.set(message.id,{ws,actorId:ws.meta.actorId,replayKey,at:Date.now()});return send(r.foundry,{...message,campaignId:ws.meta.campaignId,source:{connectionId:ws.meta.id,role:'player',name:ws.meta.name,actorId:ws.meta.actorId,tokenId:ws.meta.tokenId}})}
      if(message.kind==='response'&&message.replyTo){const p=r.pending.get(message.replyTo);if(p){send(p.ws,message);if(p.replayKey)r.replays.set(p.replayKey,message);r.pending.delete(message.replyTo)}return}if(['event','system'].includes(message.kind)){const routed={...message,campaignId:ws.meta.campaignId};if(message.type==='world.snapshot'&&!message.audience){r.latestSnapshot=routed;const c=campaign(ws.meta.campaignId);c.latestSnapshot=routed;void store.save()}const targets=message.audience?.connectionIds?[...r.clients].filter(x=>message.audience.connectionIds.includes(x.meta.id)):[...r.clients];for(const x of targets)send(x,routed);return}wsError(ws,'INVALID_FOUNDRY_MESSAGE','Invalid Foundry message')})
    ws.on('close',()=>{const r=rooms.get(ws.meta.campaignId);if(!r)return;if(r.foundry===ws){r.foundry=null;for(const[id,p]of r.pending)wsError(p.ws,'FOUNDRY_OFFLINE','Foundry disconnected',id);r.pending.clear()}else{r.clients.delete(ws);if(r.foundry)send(r.foundry,envelope('event','client.disconnected',{connectionId:ws.meta.id,actorId:ws.meta.actorId,tokenId:ws.meta.tokenId,name:ws.meta.name}))}publishStatus(r)})})
  const heartbeat=setInterval(()=>{for(const ws of wss.clients){if(!ws.isAlive)ws.terminate();else{ws.isAlive=false;ws.ping()}}},30000);heartbeat.unref()
  const cleanup=setInterval(()=>{for(const r of rooms.values())for(const[id,p]of r.pending)if(Date.now()-p.at>30000){wsError(p.ws,'COMMAND_TIMEOUT','Foundry did not answer',id);r.pending.delete(id)}store.pruneSessions()},5000);cleanup.unref()
  return {httpServer,rooms,store,async listen(){await ready;if(accessMode!=='open'&&!ownerKey)throw Error('BRIDGE_OWNER_KEY is required in secure mode');if(!httpServer.listening)await new Promise(ok=>httpServer.listen(port,host,ok));return httpServer.address()},async close(){clearInterval(heartbeat);clearInterval(cleanup);for(const ws of wss.clients)ws.terminate();await new Promise(ok=>wss.close(ok));if(httpServer.listening)await new Promise(ok=>httpServer.close(ok));await store.save()}}
}
const main=process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href
if(main){const server=createBridgeServer(),address=await server.listen();console.log(`[bridge] listening on :${address.port} (protocol v2)`);const stop=async()=>{await server.close();process.exit(0)};process.on('SIGINT',stop);process.on('SIGTERM',stop)}
