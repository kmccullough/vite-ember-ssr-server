export default function getPackageName(modulePath) {
  let parts = modulePath.split('/');

  if (modulePath[0] === '@') {
    return parts[0] + '/' + parts[1];
  }
  return parts[0];
}
