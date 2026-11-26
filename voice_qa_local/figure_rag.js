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
    return [chunk.figure ? '图'+chunk.figure : '',chunk.title,chunk.text].filter(Boolean).join(' ');
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
      const overlap=[...queryWords].reduce((total,word)=>total
        + (titleWords.has(word) ? 0.07 : evidenceWords.has(word) ? 0.025 : 0),0);
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

  function contextFor(entry, index) {
    const prefix = entry.kind === 'figure' ? (entry.figure ? '图'+entry.figure+'：' : '上传图像的自动说明：')
      : entry.figure ? '图' + entry.figure + '相关正文：' : '';
    return '[' + (index + 1) + '] ' + prefix + entry.text;
  }

  return {loadSample, embeddingText, selectSources, contextFor};
})();
