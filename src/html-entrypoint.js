import fs from 'node:fs';
import path from 'node:path';
import { parseHTML } from 'linkedom';

function mergeContent(metaElement, config, configName) {
  let name = metaElement.getAttribute('name');
  if (name && name.endsWith(configName)) {
    let content = JSON.parse(decodeURIComponent(metaElement.getAttribute('content')));
    content.APP = Object.assign({ autoboot: false }, content.APP);
    config[name.slice(0, -1 * configName.length)] = content;
    return true;
  }
  return false;
}

export default function htmlEntrypoint(appName, distPath, htmlPath) {
  let html = fs.readFileSync(path.join(distPath, htmlPath), 'utf8');
  const { document } = parseHTML(html);

  let fastbootConfig = {};
  let config = {};
  for (let element of document.querySelectorAll('meta')) {
    mergeContent(element, config, '/config/environment');
    let fastbootMerged = mergeContent(element, fastbootConfig, '/config/fastboot-environment');
    if (fastbootMerged) {
      element.remove();
    }
  }

  let isFastbootConfigBuilt = Object.keys(fastbootConfig).length > 0;
  if (isFastbootConfigBuilt) {
    config = fastbootConfig;
  }

  return { config, html: document.toString() };
}
