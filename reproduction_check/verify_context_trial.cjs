// 仅供同一浏览器中的完整上下文与精简上下文对照。
function questionBigrams(text){
  const chars=Array.from(text.toLowerCase().replace(/[^\p{L}\p{N}]/gu,""));
  return new Set(chars.slice(1).map((char,index)=>chars[index]+char));
}

function selectEvidence(text, question){
  const sentences=text.match(/[^。！？\n]+[。！？]?/g);
  // 不拆带换行的表格或多行片段。
  if(!sentences || sentences.length<2 || text.includes("\n")) return text;
  const queryTerms=questionBigrams(question);
  const scored=sentences.map(sentence=>{
    const matches=[...questionBigrams(sentence)].filter(term=>queryTerms.has(term));
    return {sentence,score:matches.length};
  });
  const best=Math.max(...scored.map(item=>item.score));
  // 有至少两个共同双字词时，保留最相关的原句（含并列句）。
  if(best<2) return text;
  return scored.filter(item=>item.score===best).map(item=>item.sentence).join("");
}

function instrument(html,promptProbe){
  const line='            evidence=ranked.map((r,i)=>"资料"+(i+1)+"（"+r.k.source+"）："+r.k.text).join("\\n");';
  if(!html.includes(line)) throw new Error('找不到候选证据注入点');
  html=html.replace(line,()=>[
    questionBigrams.toString(),
    selectEvidence.toString(),
    '            evidence=ranked.map((r,i)=>"资料"+(i+1)+"（"+r.k.source+"）："+',
    '              (window.useCompactEvidence?selectEvidence(r.k.text,q):r.k.text)).join("\\n");'
  ].join('\n'));
  if(promptProbe==='evidence-last'){
    const render='evidence=ranked.map';
    if(!html.includes(render)) throw new Error('找不到证据顺序注入点');
    html=html.replace(render,'evidence=[...ranked.slice(1),ranked[0]].map');
  }
  if(promptProbe==='brief' || promptProbe==='faithful'){
    const original='请只给出有依据的答案。';
    if(!html.includes(original)) throw new Error('找不到回答指令注入点');
    const instruction = promptProbe==='faithful' ? faithfulInstruction : '第一句直接给出有依据的答案，保留全部条件、数值和单位。必要时用一句话说明计算。';
    html=html.replace(original,instruction);
  }
  const call='await llm(prompt,{max_new_tokens:80,do_sample:false,repetition_penalty:1.15,streamer,return_full_text:false});';
  if(!html.includes(call)) throw new Error('找不到试验计量入口');
  return html.replace(call,()=>[
    '          let inputTokens,outputTokens;',
    '          const generate=llm.model.generate;',
    '          llm.model.generate=async function(options){',
    '            inputTokens=options.input_ids.dims.at(-1);',
    '            const result=await generate.call(this,options);',
    '            outputTokens=result.dims.at(-1)-inputTokens;',
    '            return result;',
    '          };',
    '          try{'+call+'}finally{llm.model.generate=generate;}',
    '          emit({type:"context-trial",inputTokens,outputTokens,evidence,wasmThreads:HF.env.backends.onnx.wasm.numThreads});'
  ].join('\n'));
}

const faithfulInstruction = '第一句直接回答问题。照原文保留数值、单位、比较关系和全部必要条件。资料没有说明时答“资料中未提及”。';
module.exports={instrument,selectEvidence,faithfulInstruction};
