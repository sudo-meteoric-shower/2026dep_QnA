const fs = require('node:fs');
const path = require('node:path');
const {spawn,execFileSync} = require('node:child_process');
const runDir = path.resolve(__dirname);
const app = path.join(runDir, '..', 'voice_qa_local');
const high=process.argv.includes('--high');
const matrix=process.argv.includes('--matrix');
const comparison = process.argv.find(arg => arg.startsWith('--compare='))?.split('=')[1];
const ortProbe=process.argv.find(arg=>arg.startsWith('--ort-probe='))?.split('=')[1];
if(ortProbe && !['trace','single','no-opt','no-opt-single'].includes(ortProbe)) throw new Error('未知 WASM 探测模式');
const requestedModel=process.argv.find(arg=>arg.startsWith('--model='))?.split('=')[1];
const supportedModels=['qwen3_06b','qwen25_15b','qwen3_17b'];
if(requestedModel && !supportedModels.includes(requestedModel)) throw new Error('未知问答模型');
const questionId=process.argv.find(arg=>arg.startsWith('--question='))?.split('=')[1];
if(questionId && !comparison) throw new Error('单题测试需要指定对照模式');
const cdpTimeout=requestedModel==='qwen3_17b'?180000:60000;
const switchAfterLoad=process.argv.includes('--switch-after-load');
if(switchAfterLoad && (!comparison || !requestedModel)) throw new Error('切换测试需要指定对照模式和目标模型');
const promptProbe=process.argv.find(arg=>arg.startsWith('--prompt-probe='))?.split('=')[1];
if(promptProbe && !['evidence-last','brief'].includes(promptProbe)) throw new Error('未知提示词探测模式');
const requestedThreads=process.argv.find(arg=>arg.startsWith('--wasm-threads='))?.split('=')[1];
if(requestedThreads && !['2','4','8'].includes(requestedThreads)) throw new Error('未知 WASM 线程数');
const contextTrial=process.argv.includes('--context-trial');
if((contextTrial || promptProbe || requestedThreads) && comparison!=='candidate') throw new Error('上下文试验需要本地候选页面');
const holdout=process.argv.includes('--holdout');
const fresh=process.argv.includes('--fresh');
const resultTag=process.argv.find(arg=>arg.startsWith('--result-tag='))?.split('=')[1];
if(resultTag && !/^[a-z0-9-]+$/.test(resultTag)) throw new Error('结果标签只支持字母、数字和连字符');
const comparisonModes = ['teacher', 'current', 'single', 'small', 'candidate', 'candidate-small'];
if (comparison && !comparisonModes.includes(comparison)) throw new Error('未知对照模式');
const diagnostic=process.argv.find(arg=>arg.startsWith('--diagnose='))?.split('=')[1];
if(diagnostic && !['default','single-thread','context','context-cleanup'].includes(diagnostic)) throw new Error('未知 1.5B 诊断模式');
const audit=Boolean(ortProbe) || Boolean(diagnostic) || Boolean(comparison) || matrix || process.argv.includes('--audit');
const auditDir=path.join(runDir,'静音评测');
const resultName=ortProbe?'1.7B-probe-'+ortProbe+(high?'-q4f16':'-q8'):diagnostic?'1.5B-'+diagnostic:comparison?comparison+(fresh?'-fresh':holdout?'-holdout':''):matrix?'模型切换':high?'高精度':'实测';
const resultFile=path.join(auditDir,resultName+(resultTag?'-'+resultTag:'')+'.json');
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
const summary = {comparison,diagnostic,ortProbe,promptProbe,requestedThreads,loadedModelFiles:[],resources:{freeVramMiB:Number(gpuMemory),freeRamMiB:Math.round(freeRam/2**20)},errors: [], failedRequests: [], remoteRequests: [], checks: {}};
if(ortProbe) summary.wasmTrace=[];
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
    }, cdpTimeout);
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
  const result = await waitEvent('answer',requestedModel==='qwen3_17b'?360000:240000);
  const metrics = await evaluate(expression(() => {
    const deltas = window.testEvents.filter(e => e.type === 'answer-delta');
    return {deltas:deltas.length,firstMs:deltas.length ? Math.round(deltas[0].ts - window._t0) : null,
      totalMs:Math.round(window.testEvents.find(e => e.type === 'answer').ts - window._t0),
      contextTrial:window.testEvents.find(e=>e.type==='context-trial'),
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
    if(ortProbe && event.method==='Runtime.consoleAPICalled'){
      const values=event.params.args.map(arg=>arg.value??arg.description);
      const message=values.join(' ');
      if(message.startsWith('ORT-PROBE ')){
        summary.wasmTrace.push(JSON.parse(message.slice('ORT-PROBE '.length)));
      }else if(/Session|onnxruntime|memory|wasm|kernel|Ort[A-Z]|allocat|Abort/i.test(message)){
        summary.wasmTrace.push({type:event.params.type,message});
      }
    }
    if (event.method === 'Runtime.consoleAPICalled' && event.params.type === 'error'){
      const message=event.params.args.map(a=>a.value||a.description).join(' ');
      if(!ortProbe || !/\[[IVW]:onnxruntime:/i.test(message)) summary.errors.push(message);
    }
    if (event.method === 'Runtime.exceptionThrown') summary.errors.push(event.params.exceptionDetails.exception?.description || event.params.exceptionDetails.text);
    if (event.method === 'Log.entryAdded' && event.params.entry.level === 'error')
      summary.errors.push(event.params.entry.text + (event.params.entry.url ? ' ' + event.params.entry.url : ''));
    if (event.method === 'Network.requestWillBeSent') {
      const {requestId, request} = event.params;
      requests.set(requestId, request.url);
      if(diagnostic || ortProbe) requests.set(requestId+':method', request.method);
      if (/^https?:/.test(request.url) && !request.url.startsWith('http://127.0.0.1:8000/')) summary.remoteRequests.push(request.url);
    }
    if (event.method === 'Network.responseReceived' &&
        ((diagnostic && event.params.response.url.includes('/models/Qwen2.5-1.5B-Instruct/')) ||
         (ortProbe && event.params.response.url.includes('/models/Qwen3-1.7B-ONNX/')))){
      const {url,status}=event.params.response;
      const method=requests.get(event.params.requestId+':method');
      summary.loadedModelFiles.push({url,status,method});
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
  if(comparison || diagnostic || ortProbe){
    let html = ortProbe ? require('./verify_1_7b.cjs').instrument(
      fs.readFileSync(path.join(app,'voice_qa_assistant_local.html'),'utf8'),ortProbe)
      : diagnostic ? require('./verify_1_5b.cjs').instrument(
      fs.readFileSync(path.join(app,'voice_qa_assistant_local.html'),'utf8'),diagnostic==='single-thread'?1:null)
      : comparison==='teacher'
      ? execFileSync('git',['show','7279dec:voice_qa_local/voice_qa_assistant_local.html'],
          {cwd:path.dirname(app),encoding:'utf8',windowsHide:true}).replaceAll('./ort2/','./ort/')
      : comparison.startsWith('candidate')
        ? fs.readFileSync(path.join(app,'voice_qa_assistant_local.html'),'utf8')
        : execFileSync('git',['show','76367a2:voice_qa_local/voice_qa_assistant_local.html'],
            {cwd:path.dirname(app),encoding:'utf8',windowsHide:true});
    if(!diagnostic){
      const cleanup = 'answer=cleanAnswer(answer);';
      assert(html.includes(cleanup),'找不到答案清洗入口');
      html=html.replace(cleanup,'emit({type:"raw-answer",text:answer});'+cleanup);
    }
    if(comparison==='single'){
      const marker='const ranked=KB.map';
      assert(html.includes(marker),'找不到证据排序入口');
      html=html.replace(marker,'const ranked=KB.filter(k=>k.source===window.testExpectedSource).map');
    }
    if(contextTrial || promptProbe || requestedThreads){
      html=require('./verify_context_trial.cjs').instrument(html,promptProbe);
      if(requestedThreads){
        const threadOption='wasm.numThreads = window.crossOriginIsolated ? Math.min(4, navigator.hardwareConcurrency || 1) : 1;';
        assert(html.includes(threadOption),'找不到 WASM 线程配置');
        html=html.replace(threadOption,'wasm.numThreads = '+Number(requestedThreads)+';');
      }
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
  if(diagnostic){
    await evaluate(`(() => {
      const select=document.getElementById('llmModel');
      if(select.value==='qwen25_15b') return;
      window.testEvents.length=0;
      select.value='qwen25_15b';
      onModelChange('llm');
    })()`);
    const selectedCheck=await waitEvent('local-checked');
    assert(selectedCheck.result.llm.ok && selectedCheck.result.llm.label==='Qwen2.5-1.5B','1.5B 诊断模型自检失败');
    await button('#llmBtn');
    await waitEvent('llm-ready');
    for(const test of require('./verify_1_5b.cjs').cases(diagnostic)){
      await evaluate(expression(data=>{
        window.diagnosticRun=data;
        window.testEvents.length=0;
        document.getElementById('questionInput').value=data.question;
      },test));
      await button('button[title="发送问题"]');
      const result=await waitEvent('answer',240000);
      const trace=await waitEvent('diagnostic-answer');
      const {type,ts,...fields}=trace;
      summary.checks[test.id]={...fields,cleaned:result.text,expected:test.expected};
      console.log(test.id,JSON.stringify({expected:test.expected,firstDifference:fields.firstDifference,
        threads:fields.wasmThreads,count:fields.outputIDs.length,hitCap:fields.hitCap,
        returnedMatchesRaw:fields.returned===fields.raw,cleaned:result.text}));
    }
    return;
  }
  const modelChoice=(ortProbe?'qwen3_17b':null) || requestedModel || (comparison==='small' || comparison==='candidate-small' ? 'qwen3_06b' : null);
  const chooseModel=async()=>{
    await evaluate(expression(model=>{
      window.testEvents.length=0;
      document.getElementById('llmModel').value=model;
      onModelChange('llm');
    },modelChoice));
    const selected=await waitEvent('local-checked');
    log('requestedModel', {model:modelChoice,files:selected.result.llm,precision:high?'high':'fast'});
    assert(selected.result.llm.ok,'所选问答模型文件未就绪');
  };
  if(modelChoice && !switchAfterLoad) await chooseModel();
  if(high) await evaluate("document.getElementById('precisionSelect').value='high';onPrecisionChange()");
  if(ortProbe || process.argv.includes('--llm-first')){
    await button('#llmBtn');
    log('llm',await waitEvent('llm-ready'));
    if(ortProbe && !comparison) return;
  }
  await button('button[onclick="loadAll()"]');
  for (const kind of ['asr','llm','emb']) {
    if(!summary.checks[kind]) log(kind,await waitEvent(kind+'-ready'));
  }
  if(switchAfterLoad){
    await chooseModel();
    await button('#llmBtn');
    log('switchedLLM',await waitEvent('llm-ready'));
  }
  if (audit) {
    log('environment',await evaluate('({isolated:crossOriginIsolated, browser:navigator.userAgent, model:document.querySelector("#llmModel").value})'));
    const {root}=await cdp('DOM.getDocument');
    const {nodeId}=await cdp('DOM.querySelector',{nodeId:root.nodeId,selector:'#fileInput'});
    const fixtures=fresh?['新题设备说明.txt','新题巡检记录.txt','新题备用设备.txt']:holdout?['留出资料.txt','留出采样.xlsx','留出干扰项.txt']:['记录器说明.docx','采样参数.xlsx','校准卡.pdf'];
    const files=fixtures.map(f=>path.join(auditDir,f));
    if(!holdout && !fresh) files.push(path.join(runDir,'课堂复现测试资料.txt'));
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
    const questionFile = fresh ? '新题题目.json' : holdout ? '留出题目.json' : '题目.json';
    const rubric=JSON.parse(fs.readFileSync(path.join(auditDir,questionFile),'utf8'));
    const selectedQuestions=questionId?.split(',');
    if(selectedQuestions){
      assert(selectedQuestions.every(id=>rubric.some(([key])=>key===id)),'本次题集中没有所选题目');
    }
    for(const [index,[key,question,,expectedSource]] of rubric.entries()){
      if(selectedQuestions && !selectedQuestions.includes(key)) continue;
      if(switchAfterLoad && !questionId && key!=='charge') continue;
      if(comparison==='single'){
        if(!expectedSource) continue;
        await evaluate(expression(source=>{window.testExpectedSource=source;},expectedSource));
      }
      if(contextTrial){
        // 交替先测完整或精简片段，减少固定运行顺序带来的偏差。
        const variants=index%2===0?['full','compact']:['compact','full'];
        for(const variant of variants){
          await evaluate(expression(compact=>{window.useCompactEvidence=compact;},variant==='compact'));
          await answer(key+'-'+variant,question,key!=='general');
          fs.writeFileSync(resultFile,JSON.stringify(summary,null,2));
        }
      }else{
        await answer(key,question,key!=='general');
        fs.writeFileSync(resultFile,JSON.stringify(summary,null,2));
      }
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
