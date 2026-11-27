const fs = require('node:fs');
const path = require('node:path');
const {spawn,execFileSync} = require('node:child_process');
const runDir = path.resolve(__dirname);
const app = path.join(runDir, '..', 'voice_qa_local');
const high=process.argv.includes('--high');
const matrix=process.argv.includes('--matrix');
const comparison = process.argv.find(arg => arg.startsWith('--compare='))?.split('=')[1];
const holdout=process.argv.includes('--holdout');
const comparisonModes = ['teacher', 'current', 'single', 'small', 'candidate', 'candidate-small'];
if (comparison && !comparisonModes.includes(comparison)) throw new Error('未知对照模式');
const audit=Boolean(comparison) || matrix || process.argv.includes('--audit');
const auditDir=path.join(runDir,'静音评测');
const resultFile=path.join(auditDir,comparison?(comparison+(holdout?'-holdout':'')+'.json'):matrix?'模型切换.json':high?'高精度.json':'实测.json');
const gpuMemory=execFileSync('nvidia-smi',['--query-gpu=memory.free','--format=csv,noheader,nounits'],{encoding:'utf8',windowsHide:true}).trim();
const freeRam=require('node:os').freemem();
console.log('启动前可用资源',gpuMemory+' MiB 显存',Math.round(freeRam/2**20)+' MiB 内存');
if(Number(gpuMemory)<512 || freeRam<7*2**30) throw new Error('可用资源不足，本轮未启动模型');
const profile = fs.mkdtempSync(path.join(runDir, 'edge-profile-'));
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const shortVoiceRun = process.argv.includes('--short-voice');
const classroomVoiceRun = process.argv.includes('--classroom-voice');
const voiceOnly = shortVoiceRun || classroomVoiceRun;
const fixture = audit || classroomVoiceRun ? 'voice_classroom.wav' : shortVoiceRun ? 'voice_short.wav' : 'voice_fixture.wav';
const hostname = '127.0.0.1';
const url = 'http://' + hostname + ':8000/voice_qa_assistant_local.html';
const summary = {comparison,resources:{freeVramMiB:Number(gpuMemory),freeRamMiB:Math.round(freeRam/2**20)},errors: [], failedRequests: [], remoteRequests: [], checks: {}};
const edgeArgs = [
  '--headless=new','--mute-audio','--disable-gpu', '--window-size=1450,950', '--remote-debugging-port=0', '--user-data-dir=' + profile,
  '--no-first-run', '--disable-background-networking', '--disable-component-update',
  '--no-proxy-server', '--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1, EXCLUDE localhost',
  '--autoplay-policy=no-user-gesture-required', '--use-fake-ui-for-media-stream',
  '--use-fake-device-for-media-stream',
  '--use-file-for-fake-audio-capture=' + path.join(runDir, fixture) + '%noloop',
  'about:blank'
];
const server = spawn('python', ['-u','serve.py'], {cwd:app, windowsHide:true, stdio:['ignore','ignore','pipe']});
server.stderr.pipe(fs.createWriteStream(path.join(runDir,'http.log')));
const edge = spawn('C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe', edgeArgs, {windowsHide:true, stdio:['ignore','ignore','pipe']});
edge.stderr.pipe(fs.createWriteStream(path.join(runDir,'browser.log')));
for (const child of [server,edge]) child.on('error', e => summary.errors.push(e.message));
let ws;
const pending = new Map();
let id = 0;
function cdp(method, params = {}) {
  return new Promise((resolve, reject) => {
    const requestId = ++id;
    const timer = setTimeout(() => {
      pending.delete(requestId);
      reject(new Error('CDP timeout: ' + method));
    }, 60000);
    pending.set(requestId, data => {
      clearTimeout(timer);
      if (data.error) reject(new Error(JSON.stringify(data.error)));
      else resolve(data.result);
    });
    ws.send(JSON.stringify({id:requestId, method, params}));
  });
}
async function poll(fn, ms, label) {
  const limit = Date.now() + ms;
  do {
    const value = await fn();
    if (value) return value;
    await pause(350);
  } while (Date.now() < limit);
  throw new Error('Timed out: ' + label);
}
async function evaluate(expression) {
  const data = await cdp('Runtime.evaluate',{expression,returnByValue:true,awaitPromise:true,userGesture:true});
  if (data.exceptionDetails) throw new Error(data.exceptionDetails.exception?.description || data.exceptionDetails.text);
  return data.result.value;
}
function expression(fn, arg) {
  return '(' + fn.toString() + ')(' + (arg === undefined ? '' : JSON.stringify(arg)) + ')';
}
const log = (key, value) => {summary.checks[key] = value; console.log(key, JSON.stringify(value));};
const assert = (cond, detail) => {if (!cond) throw new Error(detail);};
const waitEvent = (type, ms=120000) => poll(() => evaluate(expression(t => {
  return window.testEvents.find(e => e.type === 'error') || window.testEvents.find(e => e.type === t);
}, type)),ms,type).then(event => {
  if (event.type === 'error') throw new Error(event.stage + ': ' + event.message);
  return event;
});
async function button(selector) {
  const rect = await evaluate(expression(sel => {
    const r = document.querySelector(sel).getBoundingClientRect();
    return {x: r.x + r.width/2, y:r.y + r.height/2};
  }, selector));
  await cdp('Input.dispatchMouseEvent',{type:'mousePressed',...rect,button:'left',clickCount:1});
  await cdp('Input.dispatchMouseEvent',{type:'mouseReleased',...rect,button:'left',clickCount:1});
}
async function answer(label, question, useRag) {
  await evaluate(expression(({question,useRag}) => {
    window.testEvents.length = 0;
    document.querySelector('#ragToggle').checked = useRag;
    document.querySelector('#questionInput').value = question;
  }, {question,useRag}));
  await button('button[title="发送问题"]');
  return collectAnswer(label);
}
async function collectAnswer(label) {
  const result = await waitEvent('answer',240000);
  const metrics = await evaluate(expression(() => {
    const deltas = window.testEvents.filter(e => e.type === 'answer-delta');
    return {deltas:deltas.length,firstMs:deltas.length ? Math.round(deltas[0].ts - window._t0) : null,
      totalMs:Math.round(window.testEvents.find(e => e.type === 'answer').ts - window._t0),
      raw: window.testEvents.find(e=>e.type==='raw-answer')?.text,
      sourceShown:[...document.querySelectorAll('details > summary')].some(el => el.textContent.includes('RAG 引用来源'))};
  }));
  log(label, {...metrics, text:result.text, usedRag:result.usedRag, sources:result.sources});
  if(!comparison) assert(result.text && !result.text.includes('模型未返回有效内容'), label + ' returned no usable answer');
  return result;
}
function getLocal(url){
  return new Promise((resolve,reject)=>{
    require('node:http').get(url,res=>{
      const parts=[];
      res.on('data',part=>parts.push(part));
      res.on('end',()=>resolve({ok:res.statusCode===200,body:Buffer.concat(parts).toString('utf8')}));
      res.on('error',reject);
    }).on('error',reject);
  });
}
async function run() {
  await poll(async () => {try{return (await getLocal(url)).ok;} catch {return false;}},15000,'HTTP');
  const debugFile = path.join(profile,'DevToolsActivePort');
  const port = await poll(() => {
    try {return fs.readFileSync(debugFile,'utf8').split(/\s/)[0];} catch {return null;}
  },20000,'Edge remote debug port');
  const target = JSON.parse((await getLocal('http://' + hostname + ':' + port + '/json/list')).body).find(t => t.type === 'page');
  ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve,reject) => {ws.addEventListener('open',resolve,{once:true});ws.addEventListener('error',reject,{once:true});});
  const requests = new Map();
  ws.addEventListener('message', ({data}) => {
    const event = JSON.parse(data);
    if (event.id && pending.has(event.id)) {pending.get(event.id)(event);pending.delete(event.id);}
    if (event.method === 'Page.javascriptDialogOpening') {
      summary.errors.push(event.params.message);
      cdp('Page.handleJavaScriptDialog',{accept:true}).catch(e => summary.errors.push(e.message));
    }
    if (event.method === 'Runtime.consoleAPICalled' && event.params.type === 'error')
      summary.errors.push(event.params.args.map(a=>a.value||a.description).join(' '));
    if (event.method === 'Runtime.exceptionThrown') summary.errors.push(event.params.exceptionDetails.exception?.description || event.params.exceptionDetails.text);
    if (event.method === 'Log.entryAdded' && event.params.entry.level === 'error')
      summary.errors.push(event.params.entry.text + (event.params.entry.url ? ' ' + event.params.entry.url : ''));
    if (event.method === 'Network.requestWillBeSent') {
      const {requestId, request} = event.params;
      requests.set(requestId, request.url);
      if (/^https?:/.test(request.url) && !request.url.startsWith('http://127.0.0.1:8000/')) summary.remoteRequests.push(request.url);
    }
    if (event.method === 'Network.responseReceived' && event.params.response.status >= 400)
      summary.failedRequests.push({status:event.params.response.status,url:event.params.response.url});
    if (event.method === 'Network.loadingFailed' && !event.params.canceled)
      summary.failedRequests.push({status:event.params.errorText,url:requests.get(event.params.requestId)});
  });
  await cdp('Page.enable');
  await cdp('Network.enable');
  await cdp('Runtime.enable');
  await cdp('Log.enable');
  await cdp('Page.addScriptToEvaluateOnNewDocument',{source:expression(silent => {
    window.testEvents = [];
    window.testSpeech = [];
    window.addEventListener('engine-msg', e => {
      if (e.detail.type !== 'progress' && e.detail.type !== 'index-progress') {
        window.testEvents.push({...e.detail,ts:performance.now()});
      }
    });
    const speak = speechSynthesis.speak.bind(speechSynthesis);
    speechSynthesis.speak = utterance => {
      window.testSpeech.push({event:'queued',lang:utterance.lang,voice:utterance.voice?.name,text:utterance.text});
      for (const event of ['start','end','error']) utterance.addEventListener(event,e => window.testSpeech.push({event,error:e.error}));
      if (silent) return;
      utterance.volume=0;
      return speak(utterance);
    };
  },audit)});
  if(comparison){
    let html = comparison==='teacher'
      ? execFileSync('git',['show','7279dec:voice_qa_local/voice_qa_assistant_local.html'],
          {cwd:path.dirname(app),encoding:'utf8',windowsHide:true}).replaceAll('./ort2/','./ort/')
      : comparison.startsWith('candidate')
        ? fs.readFileSync(path.join(app,'voice_qa_assistant_local.html'),'utf8')
        : execFileSync('git',['show','76367a2:voice_qa_local/voice_qa_assistant_local.html'],
            {cwd:path.dirname(app),encoding:'utf8',windowsHide:true});
    const cleanup = 'answer=cleanAnswer(answer);';
    assert(html.includes(cleanup),'找不到答案清洗入口');
    html=html.replace(cleanup,'emit({type:"raw-answer",text:answer});'+cleanup);
    if(comparison==='single'){
      const marker='const ranked=KB.map';
      assert(html.includes(marker),'找不到证据排序入口');
      html=html.replace(marker,'const ranked=KB.filter(k=>k.source===window.testExpectedSource).map');
    }
    const body=Buffer.from(html,'utf8').toString('base64');
    ws.addEventListener('message',({data})=>{
      const event=JSON.parse(data);
      if(event.method==='Fetch.requestPaused'){
        cdp('Fetch.fulfillRequest',{requestId:event.params.requestId,responseCode:200,
          responseHeaders:[
            {name:'Content-Type',value:'text/html; charset=utf-8'},
            {name:'Cross-Origin-Opener-Policy',value:'same-origin'},
            {name:'Cross-Origin-Embedder-Policy',value:'require-corp'}
          ],body}).catch(error=>summary.errors.push(error.message));
      }
    });
    await cdp('Fetch.enable',{patterns:[{urlPattern:url,resourceType:'Document'}]});
  }
  await cdp('Page.navigate',{url});
  await poll(async () => {
    try {return await evaluate('document.readyState === "complete" && typeof window.EnginePost === "function"');}
    catch {return false;}
  },30000,'page');
  const selfCheck = await waitEvent('local-checked');
  log('selfCheck',selfCheck.result);
  assert(Object.values(selfCheck.result).every(v=>v.ok),'local default weights missing');
  if(comparison==='small' || comparison==='candidate-small') await evaluate("document.getElementById('llmModel').value='qwen3_06b';onModelChange('llm')");
  if(high) await evaluate("document.getElementById('precisionSelect').value='high';onPrecisionChange()");
  await button('button[onclick="loadAll()"]');
  for (const kind of ['asr','llm','emb']) log(kind, await waitEvent(kind+'-ready'));
  if (audit) {
    log('environment',await evaluate('({isolated:crossOriginIsolated, browser:navigator.userAgent, model:document.querySelector("#llmModel").value})'));
    const {root}=await cdp('DOM.getDocument');
    const {nodeId}=await cdp('DOM.querySelector',{nodeId:root.nodeId,selector:'#fileInput'});
    const fixtures=holdout?['留出资料.txt','留出采样.xlsx','留出干扰项.txt']:['记录器说明.docx','采样参数.xlsx','校准卡.pdf'];
    const files=fixtures.map(f=>path.join(auditDir,f));
    if(!holdout) files.push(path.join(runDir,'课堂复现测试资料.txt'));
    await cdp('DOM.setFileInputFiles',{nodeId,files});
    log('index',await waitEvent('index-done'));
    const parsed=await evaluate("Object.values(state.files).filter(file=>file.chunks>0).length");
    assert(parsed===files.length,'测试资料未全部建库');
    const chunks=await evaluate("chunkText('甲'.repeat(300)+'乙'.repeat(60)+'丙'.repeat(340),'测试').map(x=>typeof x==='string'?x:x.text)");
    log('chunks',{lengths:chunks.map(c=>c.length),overlap:chunks.length>1 && chunks[0].slice(-60)===chunks[1].slice(0,60)});
    if(matrix){
      for(const [asr,llm,emb,precision] of [
        ['tiny','qwen3_06b','base','fast'],['small','qwen3_17b','small','fast'],
        ['base','qwen25_15b','base','high'],['tiny','qwen3_06b','small','high'],
        ['small','qwen3_17b','small','high']]){
        const selection={asr,llm,emb,precision};
        await evaluate(expression(({asr,llm,emb,precision})=>{
          window.testEvents.length=0;
          for(const [id,val] of Object.entries({asrModel:asr,llmModel:llm,embModel:emb,precisionSelect:precision})){
            const sel=document.getElementById(id);
            if(sel.value!==val){sel.value=val;sel.dispatchEvent(new Event('change'));}
          }
          loadAll();
        },selection));
        await poll(async()=>await evaluate("window.testEvents.find(e=>e.type==='error') || (['asr','llm','emb'].every(k=>state[k]==='ready') && !window.testEvents.some(e=>e.type==='error'))"),120000,'模型切换');
        const result=await evaluate("({states:[state.asr,state.llm,state.emb],errors:window.testEvents.filter(e=>e.type==='error'),reindex:document.querySelector('#fileList').textContent})");
        log(Object.values(selection).join('/'), result);
        if(result.errors.length) throw new Error(result.errors[0].message);
      }
      return;
    }
    const questionFile = holdout ? '留出题目.json' : '题目.json';
    const rubric=JSON.parse(fs.readFileSync(path.join(auditDir,questionFile),'utf8'));
    for(const [key,question,,expectedSource] of rubric){
      if(comparison==='single'){
        if(!expectedSource) continue;
        await evaluate(expression(source=>{window.testExpectedSource=source;},expectedSource));
      }
      await answer(key,question,key!=='general');
      fs.writeFileSync(resultFile,JSON.stringify(summary,null,2));
    }
    if(comparison) return;
    await evaluate('window.testEvents.length=0;document.querySelector("#ragToggle").checked=false');
    await button('#micBtn');
    await pause(6500);
    await evaluate('window.stopAt=performance.now()');
    await button('#micBtn');
    const transcript=await waitEvent('transcript');
    log('transcript',transcript);
    await collectAnswer('voice');
    log('voiceMs',await evaluate('Math.round(window.testEvents.find(e=>e.type==="answer").ts-window.stopAt)'));
    await button('button[title="播报最新回答"]');
    log('speechCall',await evaluate('window.testSpeech'));
    log('synthesisIntercepted',true);
    const png=await cdp('Page.captureScreenshot',{format:'png'});
    if(!high) fs.writeFileSync(path.join(app,'界面预览.png'),Buffer.from(png.data,'base64'));
    return;
  }
  const question = '青岚实验箱的校验代号是什么？';
  if (!voiceOnly) await answer('plainText','深度学习是什么？请用一句话回答。',false);
  const noRag = voiceOnly ? null : await answer('withoutRag',question,false);
  await evaluate('window.testEvents.length = 0');
  const {root} = await cdp('DOM.getDocument');
  const {nodeId} = await cdp('DOM.querySelector',{nodeId:root.nodeId,selector:'#fileInput'});
  await cdp('DOM.setFileInputFiles',{nodeId,files:[path.join(runDir,'课堂复现测试资料.txt')]});
  log('index',await waitEvent('index-done'));
  if (!voiceOnly) {
    const baseline = await answer('withRag',question,true);
    assert(baseline.usedRag && baseline.sources[0]?.text.includes('松柏三七'),'RAG did not retrieve fixture');
    log('grounding', {without:noRag.text.includes('松柏三七'), with:baseline.text.includes('松柏三七')});
  }
  await evaluate('window.testEvents.length = 0');
  if (classroomVoiceRun) await evaluate('document.querySelector("#ragToggle").checked = false');
  await button('#micBtn');
  await pause(6500);
  if (classroomVoiceRun) await evaluate('document.querySelector("#ragToggle").checked = false');
  await button('#micBtn');
  log('transcript',await waitEvent('transcript'));
  const voiceAnswer = await collectAnswer('voiceAnswer');
  await button('button[title="播报最新回答"]');
  await poll(() => evaluate('window.testSpeech.some(e => e.event === "end" || e.event === "error")'),25000,'speech end');
  const speech = await evaluate(expression(() => ({
    voices:speechSynthesis.getVoices().filter(v => v.lang.startsWith('zh')).map(v => ({name:v.name,local:v.localService})),
    events:window.testSpeech
  })));
  log('speech',speech);
  log('browser',await evaluate('navigator.userAgent'));
  assert(speech.events.some(e => e.event === 'end') && !speech.events.some(e => e.event === 'error'), 'speech did not finish');
  assert(speech.voices.some(v => v.local && v.name === speech.events[0]?.voice), 'speech voice was not local');
  if (classroomVoiceRun) {
    const correct = !voiceAnswer.usedRag && /语音/.test(voiceAnswer.text) && /文字|文本|转成|转换/.test(voiceAnswer.text);
    log('voiceClassroomAnswer',correct);
    assert(correct, 'voice answer did not explain speech recognition');
  }
  if (shortVoiceRun) {
    const correct = voiceAnswer.usedRag && /(?:十五|15)\s*分钟/.test(voiceAnswer.text);
    log('voiceGroundedAnswer',correct);
    assert(correct, 'voice answer did not contain the expected charging time');
  }
}
run().catch(e => {summary.failure=e.stack;console.error(e);process.exitCode=1;}).finally(async () => {
  fs.writeFileSync(audit ? resultFile : path.join(runDir,classroomVoiceRun ? 'classroom_voice.json' : shortVoiceRun ? 'voice_followup.json' : 'result.json'),JSON.stringify(summary,null,2)+'\n');
  if (ws) {
    await cdp('Browser.close').catch(()=>{});
    ws.close();
  }
  edge.kill();
  server.kill();
  console.log('结束',summary.failure||'完成');
});
