// Resolve from the module directory so the same files work at / and /repository/.
export function assetUrl(path, base = import.meta.url) {
  return new URL(path, base).href;
}
