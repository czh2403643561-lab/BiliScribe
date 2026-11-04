(() => {
  const panelId = 'ego-page-inspector-extension-panel';
  if (document.getElementById(panelId)) return;

  const panel = document.createElement('section');
  panel.id = panelId;
  panel.setAttribute('aria-label', 'Ego 页面结构探针');
  Object.assign(panel.style, {
    position: 'fixed',
    right: '16px',
    bottom: '16px',
    zIndex: '2147483647',
    width: 'min(420px, calc(100vw - 32px))',
    maxHeight: '60vh',
    overflow: 'auto',
    boxSizing: 'border-box',
    padding: '12px',
    border: '1px solid #147d64',
    borderRadius: '10px',
    background: '#f4fffb',
    color: '#17352d',
    boxShadow: '0 8px 28px rgba(0,0,0,.22)',
    font: '13px/1.45 system-ui, sans-serif'
  });

  const heading = document.createElement('strong');
  heading.textContent = 'Ego 页面结构探针';
  const button = document.createElement('button');
  button.type = 'button';
  button.textContent = '分析此页结构';
  Object.assign(button.style, {
    margin: '8px 0',
    padding: '7px 11px',
    border: '0',
    borderRadius: '6px',
    background: '#147d64',
    color: '#fff',
    cursor: 'pointer',
    font: 'inherit'
  });

  const output = document.createElement('pre');
  output.setAttribute('aria-live', 'polite');
  output.textContent = '按“分析此页结构”读取当前文档的只读摘要。';
  Object.assign(output.style, {
    margin: '0',
    whiteSpace: 'pre-wrap',
    overflowWrap: 'anywhere',
    font: '11px/1.4 ui-monospace, monospace'
  });

  button.addEventListener('click', () => {
    const selectors = ['header', 'nav', 'main', 'article', 'section', 'aside', 'footer', 'form', 'button', 'a', 'img', 'video', 'iframe'];
    const counts = Object.fromEntries(selectors.map((selector) => [selector, document.querySelectorAll(selector).length]));
    const headings = [...document.querySelectorAll('h1,h2,h3,h4')].slice(0, 30).map((node) => ({
      level: node.tagName.toLowerCase(),
      text: (node.innerText || node.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 160)
    }));
    const topLevelContainers = [...(document.body?.children || [])].slice(0, 20).map((node) => ({
      tag: node.tagName.toLowerCase(),
      id: node.id || '',
      classes: typeof node.className === 'string' ? node.className.trim().split(/\s+/).slice(0, 5) : [],
      textLength: (node.innerText || '').trim().length
    }));
    const images = [...document.images].slice(0, 15).map((image) => ({
      alt: (image.alt || '').slice(0, 120),
      loaded: image.complete && image.naturalWidth > 0,
      width: image.naturalWidth,
      height: image.naturalHeight,
      sourceHost: (() => {
        try { return new URL(image.currentSrc || image.src).hostname; } catch { return ''; }
      })()
    }));
    const report = {
      title: document.title,
      url: location.href,
      language: document.documentElement.lang || '',
      viewport: { width: innerWidth, height: innerHeight },
      counts,
      headings,
      topLevelContainers,
      imageSample: images,
      bodyTextLength: (document.body?.innerText || '').length
    };
    output.textContent = JSON.stringify(report, null, 2);
  });

  panel.append(heading, document.createElement('br'), button, output);
  (document.body || document.documentElement).append(panel);
})();
