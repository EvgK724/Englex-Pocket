export function normalizeText(text) {
  return String(text || '').toLocaleLowerCase().replace(/ё/g, 'е').replace(/[{}\[\]]/g, '').replace(/[’‘]/g, "'").replace(/\s+/g, ' ').trim();
}

export function speechText(text) {
  return String(text).replace(/[{}\[\]]/g, '').replace(/\bsb\.?\b/gi, 'somebody').replace(/\bsth\.?\b/gi, 'something').replace(/\s+/g, ' ').trim();
}

export function selectCards(cards, state) {
  const tokens = normalizeText(state.query).split(' ').filter(Boolean);
  const result = cards.filter(c =>
    (state.kind === 'all' || c.kind === state.kind) &&
    (state.deck !== 'starred' || state.stars.has(c.id)) &&
    (state.deck !== 'review' || state.ratings[c.id] === 'review') &&
    tokens.every(t => c.search.includes(t))
  );
  if (state.sort === 'alphabetical') result.sort((a, b) => a.word.localeCompare(b.word, 'en') || a.order - b.order);
  else result.sort((a, b) => (state.sort === 'oldest' ? a.added.localeCompare(b.added) : b.added.localeCompare(a.added)) || a.order - b.order);
  return result;
}

export function chooseVoice(voices, preferredURI) {
  const english = voices.filter(v => /^en(?:[-_]|$)/i.test(v.lang));
  const preferred = english.find(v => v.voiceURI === preferredURI);
  if (preferred) return preferred;
  const score = v => (v.localService ? 50 : 0) + (/premium|enhanced|natural|neural/i.test(v.name) ? 30 : 0) + (/^en[-_]GB$/i.test(v.lang) ? 5 : /^en[-_]US$/i.test(v.lang) ? 4 : 0);
  return english.sort((a, b) => score(b) - score(a))[0] || null;
}

export function sanitizeProgress(raw, validIds) {
  if (!raw || typeof raw !== 'object' || raw.version !== 1) throw new Error('Это не копия прогресса Englex Pocket.');
  const stars = Array.isArray(raw.stars) ? raw.stars.filter(id => typeof id === 'string' && validIds.has(id)) : [];
  const ratings = Object.create(null);
  if (raw.ratings && typeof raw.ratings === 'object' && !Array.isArray(raw.ratings)) {
    for (const [id, value] of Object.entries(raw.ratings)) if (validIds.has(id) && ['review', 'known'].includes(value)) ratings[id] = value;
  }
  return {
    version: 1, stars: [...new Set(stars)], ratings,
    currentId: validIds.has(raw.currentId) ? raw.currentId : null,
    voiceURI: typeof raw.voiceURI === 'string' ? raw.voiceURI.slice(0, 300) : 'auto',
    rate: Number.isFinite(raw.rate) ? Math.min(1.15, Math.max(.65, raw.rate)) : .9,
    kind: ['all', 'word', 'collocation', 'phrasal'].includes(raw.kind) ? raw.kind : 'all',
    sort: ['newest', 'oldest', 'alphabetical'].includes(raw.sort) ? raw.sort : 'newest'
  };
}

export function formatDate(iso) {
  return /^\d{4}-\d{2}-\d{2}$/.test(iso) ? iso.split('-').reverse().join('.') : iso;
}
