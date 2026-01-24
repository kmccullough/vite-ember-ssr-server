import { parseHTML } from 'linkedom';

export default function createDocument() {
  const { document } = parseHTML('...');

  // Deprecated, but still used in glimmer
  document.createRawHTMLSection = html => {
    const element = document.createElement('div');
    element.innerHTML = html;
    const fragment = document.createDocumentFragment();
    fragment.append(...element.childNodes);
    return fragment;
  };

  return document;
}
