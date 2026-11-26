const fs = require('node:fs');
const path = require('node:path');
const {spawn} = require('node:child_process');
const runDir = path.resolve(__dirname);
const app = path.join(runDir, '..', 'voice_qa_local');
const profile = fs.mkdtempSync(path.join(runDir, 'edge-profile-'));
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const shortVoiceRun = process.argv.includes('--short-voice');
const classroomVoiceRun = process.argv.includes('--classroom-voice');
const voiceOnly = shortVoiceRun || classroomVoiceRun;
const fixture = classroomVoiceRun ? 'voice_classroom.wav' : shortVoiceRun ? 'voice_short.wav' : 'voice_fixture.wav';
const hostname = '127.0.0.1';
const url = 'http://' + hostname + ':8000/voice_qa_assistant_local.html';
const summary = {errors: [], failedRequests: [], remoteRequests: [], checks: {}};
const edgeArgs = [
  '--headless=new', '--window-size=1450,950', '--remote-debugging-port=0', '--user-data-dir=' + profile,
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
      sourceShown:[...document.querySelectorAll('details > summary')].some(el => el.textContent.includes('RAG 引用来源'))};
  }));
  log(label, {...metrics, text:result.text, usedRag:result.usedRag, sources:result.sources});
  assert(result.text && !result.text.includes('模型未返回有效内容'), label + ' returned no usable answer');
  return result;
}
async function run() {
  await poll(async () => {try{return (await fetch(url)).ok;} catch {return false;}},15000,'HTTP');
  const debugFile = path.join(profile,'DevToolsActivePort');
  const port = await poll(() => {
    try {return fs.readFileSync(debugFile,'utf8').split(/\s/)[0];} catch {return null;}
  },20000,'Edge remote debug port');
  const target = (await (await fetch('http://' + hostname + ':' + port + '/json/list')).json()).find(t => t.type === 'page');
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
  await cdp('Page.addScriptToEvaluateOnNewDocument',{source:expression(() => {
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
      return speak(utterance);
    };
  })});
  await cdp('Page.navigate',{url});
  await poll(async () => {
    try {return await evaluate('document.readyState === "complete" && typeof window.EnginePost === "function"');}
    catch {return false;}
  },30000,'page');
  const selfCheck = await waitEvent('local-checked');
  log('selfCheck',selfCheck.result);
  assert(Object.values(selfCheck.result).every(v=>v.ok),'local default weights missing');
  await button('button[onclick="loadAll()"]');
  for (const kind of ['asr','llm','emb']) log(kind, await waitEvent(kind+'-ready'));
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
  fs.writeFileSync(path.join(runDir,classroomVoiceRun ? 'classroom_voice.json' : shortVoiceRun ? 'voice_followup.json' : 'result.json'),JSON.stringify(summary,null,2)+'\n');
  if (ws) {
    ws.close();
  }
  edge.kill();
  server.kill();
  console.log('RESULT', JSON.stringify(summary));
});
