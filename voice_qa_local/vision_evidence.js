/* 使用本地量化视觉模型从用户图像生成可检索说明。 */
const VisionEvidence = (() => {
  const modelId = 'SmolVLM-256M-Instruct';
  const allowedTypes = new Set(['image/png','image/jpeg','image/webp']);
  const maxBytes = 8 * 1024 * 1024;
  let modelPromise;

  function accepts(file) {
    return allowedTypes.has(file.type);
  }

  async function load(hf) {
    const options = {local_files_only:true};
    const processor = await hf.AutoProcessor.from_pretrained(modelId,options);
    const model = await hf.Idefics3ForConditionalGeneration.from_pretrained(modelId,{
      ...options,device:'wasm',
      dtype:{embed_tokens:'q8',vision_encoder:'q8',decoder_model_merged:'q4'}
    });
    return {processor,model};
  }

  async function describe(hf,file) {
    if(!accepts(file) || file.size > maxBytes) throw new Error('请选择 8 MB 内的 PNG、JPEG 或 WebP 图像');
    const image = await hf.RawImage.fromBlob(file);
    if(Math.max(image.width,image.height)>4096) throw new Error('图片边长需小于或等于 4096 像素');
    modelPromise ??= load(hf).catch(error => {
      modelPromise=undefined;
      throw error;
    });
    const {processor,model} = await modelPromise;
    const question = 'Describe what is visible in this image in two short sentences. Include any legible labels, their positions, and the direction of any clearly visible arrows. Do not guess.';
    const prompt = processor.apply_chat_template([{role:'user',content:[
      {type:'image'},{type:'text',text:question}
    ]}],{tokenize:false,add_generation_prompt:true});
    const inputs = await processor(prompt,[image],{do_image_splitting:false});
    const tokens = await model.generate({...inputs,max_new_tokens:80,do_sample:false});
    const text = processor.decode(Array.from(tokens.data).slice(inputs.input_ids.dims[1]),
      {skip_special_tokens:true}).trim();
    if(!text) throw new Error('模型没有生成图像说明');
    return text;
  }

  return {accepts,describe};
})();
