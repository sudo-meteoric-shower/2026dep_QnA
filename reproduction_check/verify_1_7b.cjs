// 只为复现测试页采集 WASM 扩容与 ORT 初始化日志。
function installMemoryTrace(){
  const grow=WebAssembly.Memory.prototype.grow;
  const trace=(entry)=>console.info('ORT-PROBE '+JSON.stringify(entry));
  WebAssembly.Memory.prototype.grow=function(pages){
    const start=this.buffer.byteLength;
    try{
      const result=grow.call(this,pages);
      trace({action:'grow',start,requested:pages*65536,end:this.buffer.byteLength});
      return result;
    }catch(error){
      trace({action:'grow-failed',start,requested:pages*65536,message:error.message});
      throw error;
    }
  };
}

function instrument(html, mode){
  function replace(before, after){
    if(!html.includes(before)) throw new Error('找不到探测注入位置: '+before);
    html=html.replace(before,()=>after);
  }
  replace('    let HF;', '    let HF;\n    ('+installMemoryTrace.toString()+')();');
  replace('        HF.env.localModelPath = LOCAL_BASE;', [
    '        HF.env.backends.onnx.logLevel = "verbose";',
    '        HF.env.backends.onnx.debug = true;',
    '        HF.env.localModelPath = LOCAL_BASE;'
  ].join('\n'));
  if(mode.endsWith('single')){
    replace('wasm.numThreads = window.crossOriginIsolated ? Math.min(4, navigator.hardwareConcurrency || 1) : 1;', 'wasm.numThreads = 1;');
  }
  const graphOption=html.match(/graphOptimizationLevel:"(?:basic|disabled)"/)?.[0];
  if(!graphOption) throw new Error('找不到 1.7B 图优化选项');
  replace(graphOption, 'graphOptimizationLevel:"'+(mode.startsWith('no-opt')?'disabled':'basic')+'",logSeverityLevel:0,logVerbosityLevel:1');
  replace('      return HF.pipeline(task, model.local, options);', [
    '      try { return await HF.pipeline(task, model.local, options); }',
    '      catch(error){',
    '        console.info("ORT-PROBE "+JSON.stringify({action:"load-error",model:model.local,',
    '          dtype,threads:HF.env.backends.onnx.wasm.numThreads,detail:String(error),stack:error?.stack}));',
    '        throw error;',
    '      }'
  ].join('\n'));
  const generate='await llm(prompt,{max_new_tokens:80,do_sample:false,repetition_penalty:1.15,streamer,return_full_text:false});';
  replace(generate, [
    'try{'+generate+'}',
    'catch(error){',
    '  console.info("ORT-PROBE "+JSON.stringify({action:"generate-error",detail:String(error),stack:error?.stack}));',
    '  throw error;',
    '}'
  ].join('\n'));
  return html;
}
module.exports={instrument};
