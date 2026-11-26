/* 本地课件资料、图像标注及混合检索。 */
const FigureRag = (() => {
  const directory = './course_sample/';

  async function loadSample() {
    const response = await fetch(directory + 'aerodynamics.json');
    if (!response.ok) throw new Error('课件索引读取失败');
    const sample = await response.json();
    const text = sample.text.map(entry => ({
      ...entry,
      kind: 'text',
      source: sample.title + ' · 第 ' + entry.page + ' 页 · 正文摘要'
    }));
    const figures = sample.figures.map(entry => {
      if (!/^figure-[\d-]+\.png$/.test(entry.image)) throw new Error('图像文件名无效');
      return {
        ...entry,
        kind: 'figure',
        image: directory + entry.image,
        source: sample.title + ' · 第 ' + entry.page + ' 页 · 图 ' + entry.figure
      };
    });
    return {title:sample.title, chunks:[...text,...figures], figureCount:figures.length};
  }

  function embeddingText(chunk) {
    const printed=chunk.ocr?.lines.map(line=>line.text).join(' ').slice(0,1000);
    return [chunk.figure ? '图'+chunk.figure : '',chunk.title,printed,chunk.text].filter(Boolean).join(' ');
  }

  const chineseWords = new Intl.Segmenter('zh-CN',{granularity:'word'});

  function normalize(text) {
    return text.normalize('NFKC').toLowerCase();
  }

  function words(text) {
    return new Set([...chineseWords.segment(normalize(text))]
      .filter(item=>item.isWordLike && item.segment.length>1).map(item=>item.segment));
  }

  function matchesLabel(question,label) {
    const normalized=normalize(label).trim();
    if(/^[a-z]$/.test(normalized)){
      return normalize(question).split(/[^a-z0-9]+/).includes(normalized);
    }
    return normalize(question).replace(/\s+/g,'').includes(normalized.replace(/\s+/g,''));
  }

  function selectSources(chunks, question, vector, useFigures, similarity) {
    const figureIds = new Set(
      Array.from(normalize(question).matchAll(/图\s*(\d+(?:[.-]\d+)+)/g), match =>
        match[1].replace(/-/g, '.'))
    );
    const candidates=chunks.filter(entry=>
      entry.kind!=='figure' || (useFigures && (!figureIds.size || figureIds.has(entry.figure))));
    const named=candidates.filter(entry=>figureIds.has(entry.figure));
    const queryWords=words(question);
    const ranked=(named.length ? named : candidates).map(({embedding,collection,observations,...entry})=>{
      const relevant=observations?.filter(observation=>
        observation.labels.some(label=>matchesLabel(question,label)));
      const text=relevant?.length ? relevant.map(observation=>observation.text).join(' ') : entry.text;
      const score=similarity(vector,embedding);
      const titleWords=words(entry.title || '');
      const evidenceWords=words(text);
      const printedWords=words(entry.ocr?.lines.map(line=>line.text).join(' ') || '');
      const overlap=[...queryWords].reduce((total,word)=>total
        + (titleWords.has(word) || printedWords.has(word) ? 0.07 : evidenceWords.has(word) ? 0.025 : 0),0);
      const labelBoost=relevant?.length ? 0.18 : 0;
      const namedFigureBoost=named.length && entry.kind==='figure' ? 1 : 0;
      return {source:{...entry,text,score},rank:score+Math.min(overlap,0.25)+labelBoost+namedFigureBoost};
    }).sort((a,b)=>b.rank-a.rank);

    const first=ranked[0]?.source;
    if(!first) return [];
    if(first.kind==='figure'){
      // 保留一张主图。相关正文来自同一图号，减少邻图的方向和数值混入。
      const supporting=first.figure ? ranked.slice(1).filter(entry=>
        entry.source.kind!=='figure' && entry.source.figure===first.figure) : [];
      return [first,...supporting.slice(0,2).map(entry=>entry.source)];
    }
    return ranked.filter(entry=>entry.source.kind!=='figure').slice(0,3).map(entry=>entry.source);
  }

  function printedField(chunks,question) {
    // 字段和值都来自同一个 OCR 行。只处理明确询问字段值的问题。
    if(!/是什么|是多少|是几|的值|what (?:is|are)|how (?:much|many)/i.test(question)) return null;
    if(/比较|区别|不是|是不是|大于|小于|相加|差值|推断|compare|difference/i.test(question)) return null;
    const query=normalize(question);
    const queryWords=' '+(query.match(/[a-z0-9]+/g)||[]).join(' ')+' ';
    const named=chunks.filter(entry=>entry.ocr?.lines.length && entry.source
      && query.includes(normalize(entry.source)));
    const matches=[];
    for(const entry of named.length ? named : chunks){
      for(const line of entry.ocr?.lines||[]){
        const pair=line.text.match(/^\s*([^:：]{2,48})[:：]\s*(\S.*)$/u);
        if(!pair) continue;
        const [,label,value]=pair;
        const normalized=normalize(label.trim());
        const plain=normalized.replace(/\s+/g,'');
        const hit=/[\p{Script=Han}]/u.test(plain)
          ? plain.length>1 && query.replace(/\s+/g,'').includes(plain)
          : /^[a-z0-9]+(?:[ -]+[a-z0-9]+)*$/.test(normalized)
            && queryWords.includes(' '+normalized.replace(/[ -]+/g,' ')+' ');
        if(hit) matches.push({label:plain,value,entry});
      }
    }
    if(!matches.length || new Set(matches.map(match=>match.label)).size!==1) return null;
    const values=[...new Set(matches.map(match=>match.value))];
    const matchingEntries=[...new Set(matches.map(match=>match.entry))];
    const sources=matchingEntries.slice(0,3).map(({embedding,collection,...entry})=>entry);
    const text=values.length===1
      ? 'OCR 识别为 '+values[0]+'。'
      : '图片识别到多个读数：'+values.slice(0,3).join('、')+'。请指定要看的图片。';
    return {text,sources};
  }

  function ocrLines(entry,question='') {
    if(!entry.ocr?.lines.length) return [];
    const terms=words(question);
    const ranked=entry.ocr.lines.map(line=>{
      const lineWords=words(line.text);
      return {line,score:[...terms].filter(word=>lineWords.has(word)).length};
    }).sort((a,b)=>b.score-a.score);
    return ranked.slice(0,8).map(({line})=>{
      if(!line.words.length) return line.text;
      const left=Math.min(...line.words.map(word=>word.x));
      const right=Math.max(...line.words.map(word=>word.x+word.width));
      const top=Math.min(...line.words.map(word=>word.y));
      const bottom=Math.max(...line.words.map(word=>word.y+word.height));
      const x=(left+right)/(2*entry.ocr.width);
      const y=(top+bottom)/(2*entry.ocr.height);
      const horizontal=x<1/3?'左侧':x>2/3?'右侧':'水平居中';
      const vertical=y<1/3?'上部':y>2/3?'下部':'中部';
      return line.text+'（原图'+vertical+'，'+horizontal+'）';
    });
  }

  function contextFor(entry,index,question) {
    const header='['+(index+1)+'] ';
    if(entry.kind==='figure' && !entry.figure){
      const printed=ocrLines(entry,question);
      return header+[
        printed.length ? 'OCR 识别文字与原图位置：'+printed.join('；') : '',
        entry.text ? '视觉模型推测的画面描述：'+entry.text : ''
      ].filter(Boolean).join('\n');
    }
    const prefix=entry.kind==='figure' ? '图'+entry.figure+'：'
      : entry.figure ? '图'+entry.figure+'相关正文：' : '';
    return header+prefix+entry.text;
  }

  return {loadSample, embeddingText, selectSources, contextFor, ocrLines, printedField};
})();
