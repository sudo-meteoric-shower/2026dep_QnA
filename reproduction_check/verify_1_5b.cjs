const minimalCases = [
  {id:'15min', question:'设备启用前需充电多久？', text:'设备启用前需充电十五分钟。', expected:'十五分钟'},
  {id:'40min', question:'设备启用前需充电多久？', text:'设备启用前需充电四十分钟。', expected:'四十分钟'},
  {id:'code', question:'请逐字复述设备的校验代号。', text:'设备的校验代号是松柏三七。', expected:'松柏三七'}
];

function instrument(html, threads) {
  function replace(target, text) {
    if(!html.includes(target)) throw new Error('诊断注入位置发生变化: '+target);
    html=html.replace(target,()=>text);
  }
  if(threads===1){
    replace('wasm.numThreads = window.crossOriginIsolated ? Math.min(4, navigator.hardwareConcurrency || 1) : 1;',
      'wasm.numThreads = 1;');
  }
  const ragStart=html.indexOf('          if(m.useRag && KB.length && embed){');
  const rankedEnd=html.indexOf('            sources=ranked.map',ragStart);
  if(ragStart<0 || rankedEnd<0) throw new Error('找不到诊断用检索入口');
  html=html.slice(0,ragStart)+
    '          if(window.diagnosticRun){\n'+
    '            const ranked=window.diagnosticRun.sources.map(k=>({k,score:null}));\n'+html.slice(rankedEnd);
  const call='await llm(prompt,{max_new_tokens:80,do_sample:false,repetition_penalty:1.15,streamer,return_full_text:false});';
  replace(call,`const templateIDs=Array.from(tok.apply_chat_template(messages,{
            tokenize:true,add_generation_prompt:true,enable_thinking:false
          }).data,Number);
          let actualIDs, outputIDs, actualMask;
          const originalGenerate=llm.model.generate;
          llm.model.generate=async function(options){
            actualIDs=Array.from(options.input_ids.data,Number);
            actualMask=Array.from(options.attention_mask.data,Number);
            const output=await originalGenerate.call(this,options);
            outputIDs=Array.from(output.data,Number).slice(actualIDs.length);
            return output;
          };
          let result;
          try{
            result=await llm(prompt,{max_new_tokens:80,do_sample:false,repetition_penalty:1.15,streamer,return_full_text:false});
          }finally{
            llm.model.generate=originalGenerate;
          }
          const firstDifference=Array.from({length:Math.max(templateIDs.length,actualIDs.length)})
            .findIndex((_,index)=>templateIDs[index]!==actualIDs[index]);
          emit({type:"diagnostic-answer",evidence,question:q,prompt,templateIDs,actualIDs,actualMask,firstDifference,
            actualDecoded:tok.decode(actualIDs,{skip_special_tokens:false}),
            raw:answer,returned:result[0].generated_text,
            decodedNewTokens:tok.decode(outputIDs,{skip_special_tokens:true}), outputIDs,
            hitCap:outputIDs.length===80, eos:llm.model.generation_config?.eos_token_id,
            tokenizer:tok.constructor.name, model:MODEL_FILES.llm.local,
            modelType:llm.model.config.model_type,wasmThreads:HF.env.backends.onnx.wasm.numThreads,
            dtype:precision==="fast"?"q8":null});`);
  replace('sources,usedRag:!!(m.useRag&&KB.length)','sources,usedRag:!!evidence');
  return html;
}

function cases(mode) {
  const basic=minimalCases.map(test=>({...test,sources:[{source:'合成资料.txt',text:test.text}]}));
  if(!mode.startsWith('context')) return basic;
  const aroundCase=basic.find(test=>test.id==='40min');
  const around={...aroundCase,id:'40min-neighbors',sources:[{
    source:aroundCase.sources[0].source,
    text:'设备用于本地问答的模拟验收。'+aroundCase.text+'设备的校验代号是松柏三七。'
  }]};
  return [around,{...around,id:'40min-top3',sources:[
    ...around.sources,
    {source:'记录器说明.txt',text:'当供电电压连续五秒低于九伏时，记录器会自动进入备用模式。'},
    {source:'校准卡.txt',text:'Calibration card: device ID NX-42.'}
  ]}];
}

module.exports={instrument,cases};
