const matchRegex = /^regexp:(.)((?:\\\1|[^\1])+)\1([^\1]*)$/;

export function matchesSerializedRegExp(string) {
  return typeof string === 'string' ? string.match(matchRegex) : false;
}

export function serializeRegExp(regex) {
  if (!(regex && typeof regex === 'object' && regex[Symbol.match])) {
    return regex;
  }
  return `regexp:/${regex.source}/${regex.flags}`;
}

export function deserializeRegExp(string) {
  const match = matchesSerializedRegExp(string);
  return match ? new RegExp(match[2], match[3]) : string;
}
