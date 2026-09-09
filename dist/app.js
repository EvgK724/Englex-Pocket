import {normalizeText, speechText, selectCards, chooseVoice, sanitizeProgress, formatDate} from './core.mjs';
import {RecordedSpeech} from './recorded-speech.mjs';
import {assetUrl} from './paths.mjs';

const $ = id => document.getElementById(id);
const icons = {
  settings:'<path d="m9.7 4.3.6-2.3h3.4l.6 2.3 2 .9 2.1-.6 1.7 2.9-1.5 1.7.2 2.2 1.5 1.7-1.7 2.9-2.1-.6-2 .9-.6 2.3h-3.4l-.6-2.3-2-.9-2.1.6-1.7-2.9L5.7 13l-.2-2.2L4 9.1l1.7-2.9 2.1.6z"/><circle cx="12" cy="11" r="3"/>',
  search:'<circle cx="10.5" cy="10.5" r="6.5"/><path d="m16 16 4.5 4.5"/>',
  star:'<path d="m12 3 2.8 5.7 6.2.9-4.5 4.4 1.1 6.2-5.6-3-5.6 3 1.1-6.2L3 9.6l6.2-.9z"/>',
  layers:'<path d="m12 3 10 5-10 5L2 8zM2 12l10 5 10-5M2 16l10 5 10-5"/>',
  volume:'<path d="m11 4-6 5H2v6h3l6 5zM15 8a6 6 0 0 1 0 8M18 5a10 10 0 0 1 0 14"/>',
  rotate:'<path d="M3 10a9 9 0 0 1 15.5-5.5L21 7M21 2v5h-5M21 14A9 9 0 0 1 5.5 19.5L3 17M3 22v-5h5"/>',
  repeat:'<path d="m17 2 4 4-4 4M3 11V8a2 2 0 0 1 2-2h16M7 22l-4-4 4-4M21 13v3a2 2 0 0 1-2 2H3"/>',
  shuffle:'<path d="m18 3 3 3-3 3M18 15l3 3-3 3M3 6h3c5 0 7 12 12 12h3M3 18h3c2 0 4-3 6-6M14 8c1-1 2-2 4-2h3"/>',
  check:'<path d="m5 12 4 4L19 6"/>',
  left:'<path d="m14 6-6 6 6 6"/>',
  right:'<path d="m10 6 6 6-6 6"/>',
  close:'<path d="m6 6 12 12M18 6 6 18"/>',
  phone:'<rect x="6" y="2" width="12" height="20" rx="3"/><path d="M10 18h4"/>'
};
document.querySelectorAll('[data-icon]').forEach(node => {
  const svg = document.createElementNS('http://www.w3.org/2000/svg','svg');
  for (const [key,value] of Object.entries({viewBox:'0 0 24 24',fill:'none',stroke:'currentColor','stroke-width':'1.7','stroke-linecap':'round','stroke-linejoin':'round','aria-hidden':'true'})) svg.setAttribute(key,value);
  svg.innerHTML=icons[node.dataset.icon] || '';
  node.replaceWith(svg);
});

const STORAGE_KEY='englex-pocket-v1';
const state={cards:[],filtered:[],stars:new Set(),ratings:Object.create(null),query:'',kind:'all',sort:'newest',deck:'all',index:0,flipped:false,rate:.9,voiceURI:'auto'};
let byId=new Map(),metadata=null, toastTimer,storageWarning=false;
let currentId=null;
let audioIds=new Set();
const failedRecordings=new Set();
const recordedSpeech=new RecordedSpeech();
const phoneMedia=matchMedia('(max-width: 820px), (max-width: 1024px) and (pointer: coarse)');
function syncPhoneLayout(){
  if($('collection-dialog').open)$('collection-dialog').close();
  (phoneMedia.matches?$('collection-dialog-body'):$('collection-home')).append($('collection-panel'));
  document.documentElement.classList.toggle('phone-layout',phoneMedia.matches);
}
function openCollection(){if(phoneMedia.matches&&!$('collection-dialog').open)$('collection-dialog').showModal();$('search').focus();}
function closeCollection(){if($('collection-dialog').open)$('collection-dialog').close();}
function syncInstalledState(){
  const installed=matchMedia('(display-mode: standalone)').matches||navigator.standalone===true;
  document.documentElement.classList.toggle('installed-app',installed);
  if(installed)$('install-description').textContent='Englex Pocket уже открыт как отдельное приложение.';
}
function toast(message){$('toast').textContent=message;$('toast').hidden=false;clearTimeout(toastTimer);toastTimer=setTimeout(()=>$('toast').hidden=true,3000);}
function current(){return state.filtered[state.index] || null;}
function progress(){return {version:1,recordedVoiceVersion:1,stars:[...state.stars],ratings:state.ratings,currentId:current()?.id || currentId,rate:state.rate,voiceURI:state.voiceURI,kind:state.kind,sort:state.sort};}
function save(){try{localStorage.setItem(STORAGE_KEY,JSON.stringify(progress()));}catch{if(!storageWarning){toast('Браузер не сохраняет прогресс. Копию можно скачать в настройках.');storageWarning=true;}}}
function loadProgress(){try{const raw=JSON.parse(localStorage.getItem(STORAGE_KEY) || 'null');if(raw){const p=sanitizeProgress(raw,new Set(byId.keys()));state.stars=new Set(p.stars);state.ratings=p.ratings;state.rate=p.rate;state.voiceURI=raw.recordedVoiceVersion===1?p.voiceURI:'auto';state.kind=p.kind;state.sort=p.sort;currentId=p.currentId;}}catch{toast('Сохранённый прогресс недоступен. Словарь можно использовать.');}}
function updateCounts(){
  const count=n=>n.toLocaleString('ru-RU');
  $('total-count').textContent=count(state.cards.length);$('all-count').textContent=count(state.cards.length);$('star-count').textContent=count(state.stars.size);
  const values=Object.values(state.ratings);
  $('review-count').textContent=count(values.filter(v=>v==='review').length);
  $('footer-progress').textContent=values.length ? `Отмечено ${count(values.length)} из ${count(state.cards.length)}` : `${count(state.cards.length)} слов и фраз`;
}
function renderWord(node,word){
  node.replaceChildren();
  const parts=word.split(/(\{[^}]+\})/g);
  for(const part of parts){if(part.startsWith('{')&&part.endsWith('}')){const span=document.createElement('span');span.className='pattern';span.textContent=part.slice(1,-1);node.append(span);}else node.append(document.createTextNode(part));}
}

let cardTextFrame=0;
function fitCardText(){
  cardTextFrame=0;
  if($('card-stage').hidden)return;
  for(const id of ['card-word','back-word','card-translation']){
    const node=$(id);
    // Restore the designed size for every card and after rotation. Phrases
    // wrap naturally; shrink only if an individual word still overflows.
    node.style.removeProperty('font-size');
    if(!node.clientWidth||node.scrollWidth<=node.clientWidth)continue;
    let low=1,high=parseFloat(getComputedStyle(node).fontSize);
    for(let step=0;step<12;step++){
      const size=(low+high)/2;
      node.style.fontSize=`${size}px`;
      // Layout widths remain valid while either card face is rotated.
      if(node.scrollWidth>node.clientWidth)high=size;else low=size;
    }
    node.style.fontSize=`${Math.floor(low*10)/10}px`;
  }
}
function scheduleCardTextFit(){
  cancelAnimationFrame(cardTextFrame);
  cardTextFrame=requestAnimationFrame(fitCardText);
}

function flip(force){
  if(!current())return;
  state.flipped=typeof force==='boolean'?force:!state.flipped;
  $('flashcard').classList.toggle('flipped',state.flipped);
  $('card-front').inert=state.flipped;$('card-front').setAttribute('aria-hidden',String(state.flipped));
  $('card-back').inert=!state.flipped;$('card-back').setAttribute('aria-hidden',String(!state.flipped));
  $('flip').setAttribute('aria-pressed',String(state.flipped));$('flip-label').textContent=state.flipped?'Вернуться к английскому':'Показать перевод';
  $('rating-row').hidden=!state.flipped;
  $('progress-note').textContent=state.flipped?'Оцените, насколько легко вспомнили':'Сначала вспомните значение';
}
function renderCard(){
  recordedSpeech.stop();
  const c=current();
  $('card-stage').hidden=!c;$('empty-state').hidden=!!c;
  $('position-label').textContent=c?`${(state.index+1).toLocaleString('ru-RU')} / ${state.filtered.length.toLocaleString('ru-RU')}`:'0';
  $('deck-label').textContent=state.query?'Результаты поиска':({all:'Вся коллекция',starred:'Избранное',review:'К повторению'}[state.deck]);
  $('shuffle').disabled=state.filtered.length<2;
  if(!c){
    $('empty-title').textContent=state.query?'Ничего не найдено':state.deck==='starred'?'Соберите свою колоду':state.deck==='review'?'Здесь будет повторение':'Нет карточек этого типа';
    $('empty-text').textContent=state.query?'Попробуйте часть английского слова или русский перевод.':state.deck==='starred'?'Нажимайте звёздочку на карточках, к которым хотите вернуться.':state.deck==='review'?'Откройте перевод и отметьте «Повторить», если значение было трудно вспомнить.':'Измените фильтр, чтобы продолжить.';
    return;
  }
  currentId=c.id;flip(false);
  $('card-kind').textContent=({word:'Слово',collocation:'Сочетание',phrasal:'Фразовый глагол'}[c.kind] || 'Выражение');
  renderWord($('card-word'),c.word);$('card-word').classList.toggle('long',c.word.length>26);
  $('card-ipa').textContent=c.ipa?`/${c.ipa.replace(/^\/+|\/+$/g,'')}/`:'';$('card-ipa').hidden=!c.ipa;
  $('back-word').textContent=c.word.replace(/[{}]/g,'');$('card-translation').textContent=c.translation;
  $('card-date').textContent=formatDate(c.added);$('card-lists').textContent=c.lists || 'Личный словарь';
  $('card-state').textContent=state.ratings[c.id]==='known'?'Отметка: знаю':state.ratings[c.id]==='review'?'К повторению':'';
  $('flashcard').setAttribute('aria-label',`Карточка ${state.index+1}: ${c.word.replace(/[{}]/g,'')}`);
  for(const id of ['star-front','star-back']){$(id).setAttribute('aria-pressed',String(state.stars.has(c.id)));$(id).setAttribute('aria-label',state.stars.has(c.id)?'Убрать из избранного':'Добавить в избранное');}
  for(const id of ['speak-front','speak-back'])$(id).setAttribute('aria-label',`Озвучить ${speechText(c.word)}`);
  updateAudioButtons();
  $('previous').disabled=state.index===0;$('next').disabled=state.index===state.filtered.length-1;
  scheduleCardTextFit();
  save();
}
function renderResults(){
  const box=$('search-results');box.replaceChildren();box.hidden=!state.query;
  if(!state.query)return;
  const label=document.createElement('p');label.className='result-label';label.textContent=`Найдено: ${state.filtered.length.toLocaleString('ru-RU')}`;box.append(label);
  state.filtered.slice(0,15).forEach(c=>{const b=document.createElement('button');b.className='search-result';const w=document.createElement('strong');w.lang='en';w.textContent=c.word.replace(/[{}]/g,'');const t=document.createElement('span');t.textContent=c.translation;b.append(w,t);b.addEventListener('click',()=>{state.index=state.filtered.findIndex(x=>x.id===c.id);renderCard();closeCollection();});box.append(b);});
  if(state.filtered.length>15){const more=document.createElement('p');more.className='result-label';more.textContent='Первые 15 совпадений. Остальные доступны стрелками у карточки.';box.append(more);}
}
function applyFilters(preferId=null){state.filtered=selectCards(state.cards,state);const index=preferId?state.filtered.findIndex(c=>c.id===preferId):-1;state.index=index>=0?index:0;renderResults();renderCard();updateCounts();}
function move(delta){const index=state.index+delta;if(index>=0&&index<state.filtered.length){state.index=index;renderCard();}}
function mark(value){
  const c=current();if(!c||!state.flipped)return;
  state.ratings[c.id]=value;save();updateCounts();
  if(state.deck==='review'&&value==='known'){const oldIndex=state.index;state.filtered=state.filtered.filter(x=>x.id!==c.id);state.index=Math.min(oldIndex,Math.max(0,state.filtered.length-1));renderResults();renderCard();}
  else if(state.index<state.filtered.length-1)move(1);else{renderCard();toast('Вы дошли до конца выбранной колоды.');}
}
function toggleStar(){const c=current();if(!c)return;const was=state.stars.has(c.id);if(was)state.stars.delete(c.id);else state.stars.add(c.id);save();updateCounts();if(state.deck==='starred'&&was){const old=state.index;state.filtered=state.filtered.filter(x=>x.id!==c.id);state.index=Math.min(old,Math.max(0,state.filtered.length-1));renderResults();renderCard();}else{for(const id of ['star-front','star-back']){$(id).setAttribute('aria-pressed',String(!was));$(id).setAttribute('aria-label',was?'Добавить в избранное':'Убрать из избранного');}}}

// Keep utterances alive and preserve the queue: this is the playback approach
// already confirmed by the learner on their device.
let synth=null;try{synth=window.speechSynthesis;}catch{}
const speechSupported=!!synth&&typeof window.SpeechSynthesisUtterance==='function';
let voices=[],epoch=0,nextJob=0;
const speechJobs=new Map();
function refreshVoices(){
  if(speechSupported)try{const found=synth.getVoices().filter(v=>/^en(?:[-_]|$)/i.test(v.lang));if(found.length)voices=found;}catch{}
  const select=$('voice-select');select.replaceChildren(new Option(audioIds.size?'AI Voice · мягкий голос':'Лучший доступный английский','auto'));
  if(speechSupported)select.add(new Option('Автовыбор голоса устройства','device:auto'));
  voices.forEach(v=>select.add(new Option(`${v.name} · ${v.lang}`,v.voiceURI)));
  select.value=state.voiceURI==='device:auto'||voices.some(v=>v.voiceURI===state.voiceURI)?state.voiceURI:'auto';
}
function canPlayRecording(card){return (state.voiceURI==='auto'||!speechSupported)&&card&&audioIds.has(card.id)&&!failedRecordings.has(card.id);}
function updateAudioButtons(){
  for(const id of ['speak-front','speak-back'])if($(id).getAttribute('aria-busy')!=='true')$(id).disabled=!canPlayRecording(current())&&!speechSupported;
  if($('test-voice').getAttribute('aria-busy')!=='true')$('test-voice').disabled=!speechSupported&&!canPlayRecording(byId.get('8c7b57756ded59cf6ce7'));
}
function pronounce(card,button){
  if(!card||button.disabled)return;
  if(!canPlayRecording(card)){recordedSpeech.stop();speak(card.word,button);return;}
  if(speechJobs.size)resetSpeech();
  // Stop first: the old request may have used this same persistent card button.
  recordedSpeech.stop();
  button.disabled=true;button.setAttribute('aria-busy','true');$('audio-reset').hidden=false;
  $('audio-status').textContent='Загружаем запись AI Voice…';
  recordedSpeech.play(assetUrl(`audio/${card.id}.mp3`),{rate:state.rate,
    onStart:()=>{$('audio-status').textContent=`AI Voice: ${speechText(card.word)}`;},
    onFinish:()=>{button.removeAttribute('aria-busy');button.disabled=false;$('audio-status').textContent='';$('audio-reset').hidden=true;updateAudioButtons();},
    onError:()=>{failedRecordings.add(card.id);updateAudioButtons();
      if(speechSupported){button.disabled=false;speak(card.word,button);}
      else{$('audio-status').textContent='Не удалось загрузить запись. Проверьте подключение и нажмите «Перезапустить звук».';$('audio-reset').hidden=false;}
    }
  });
}
function resumeSpeech(){try{if(synth?.paused)synth.resume();}catch{}}
function finishSpeech(id,failed){const job=speechJobs.get(id);if(!job)return;clearTimeout(job.timer);speechJobs.delete(id);job.button.disabled=!speechSupported;job.button.removeAttribute('aria-busy');$('audio-status').textContent=failed?'Звук не запустился. Перезапустите озвучку и нажмите ещё раз.':speechJobs.size?'Следующая фраза — в очереди.':'';$('audio-reset').hidden=!failed&&!speechJobs.size;}
function speak(text,button){
  if(!speechSupported||button.disabled)return;
  refreshVoices();resumeSpeech();
  const utterance=new SpeechSynthesisUtterance(speechText(text));const voice=chooseVoice(voices,state.voiceURI);
  if(voice)utterance.voice=voice;
  utterance.lang=voice?.lang.replace('_','-') || 'en-US';utterance.rate=state.rate;utterance.volume=1;
  const id=++nextJob,jobEpoch=epoch,expectedMs=Math.max(3500,utterance.text.length*110/state.rate);
  const waitMs=[...speechJobs.values()].reduce((sum,j)=>sum+j.expectedMs,0);
  const stall=()=>{if(!speechJobs.has(id)||jobEpoch!==epoch)return;$('audio-status').textContent='Озвучка задержалась. Нажмите «Перезапустить звук» и повторите.';$('audio-reset').hidden=false;};
  const job={button,utterance,expectedMs,timer:setTimeout(stall,waitMs+expectedMs+15000)};speechJobs.set(id,job);
  button.disabled=true;button.setAttribute('aria-busy','true');$('audio-reset').hidden=false;$('audio-status').textContent=speechJobs.size>1?'Добавлено в очередь.':'Запуск озвучки…';
  utterance.onstart=()=>{if(jobEpoch!==epoch||!speechJobs.has(id))return;clearTimeout(job.timer);job.timer=setTimeout(stall,expectedMs+15000);$('audio-status').textContent=`Озвучивается: ${utterance.text}`;};
  utterance.onend=()=>{if(jobEpoch===epoch)finishSpeech(id,false);};utterance.onerror=()=>{if(jobEpoch===epoch)finishSpeech(id,true);};
  try{synth.speak(utterance);resumeSpeech();}catch{finishSpeech(id,true);}
}
function resetSpeech(){recordedSpeech.stop();failedRecordings.clear();epoch++;speechJobs.forEach(j=>{clearTimeout(j.timer);j.button.disabled=!speechSupported;j.button.removeAttribute('aria-busy');});speechJobs.clear();try{synth?.cancel();}catch{}resumeSpeech();refreshVoices();updateAudioButtons();$('audio-reset').hidden=true;$('audio-status').textContent='Нажмите на динамик рядом с английским выражением.';}
function bindEvents(){
  $('flip').addEventListener('click',()=>flip());$('flashcard').addEventListener('click',e=>{if(e.target.closest('button')||getSelection()?.toString())return;flip();});
  $('previous').addEventListener('click',()=>move(-1));$('next').addEventListener('click',()=>move(1));
  $('mark-review').addEventListener('click',()=>mark('review'));$('mark-known').addEventListener('click',()=>mark('known'));
  ['star-front','star-back'].forEach(id=>$(id).addEventListener('click',toggleStar));
  ['speak-front','speak-back'].forEach(id=>$(id).addEventListener('click',()=>pronounce(current(),$(id))));
  $('test-voice').addEventListener('click',()=>pronounce(byId.get('8c7b57756ded59cf6ce7')||{word:'Recover.'},$('test-voice')));
  $('audio-reset').addEventListener('click',resetSpeech);
  document.querySelectorAll('[data-deck]').forEach(b=>b.addEventListener('click',()=>{state.deck=b.dataset.deck;document.querySelectorAll('[data-deck]').forEach(t=>{t.classList.toggle('active',t===b);t.setAttribute('aria-pressed',String(t===b));});applyFilters();}));
  $('search').addEventListener('input',()=>{state.query=$('search').value;applyFilters();});
  $('kind-filter').addEventListener('change',()=>{state.kind=$('kind-filter').value;applyFilters();save();});
  $('sort-order').addEventListener('change',()=>{state.sort=$('sort-order').value;applyFilters();save();});
  $('clear-filters').addEventListener('click',()=>{state.query='';state.kind='all';state.deck='all';$('search').value='';$('kind-filter').value='all';document.querySelector('[data-deck="all"]').click();});
  $('shuffle').addEventListener('click',()=>{for(let i=state.filtered.length-1;i>0;i--){const j=Math.floor(Math.random()*(i+1));[state.filtered[i],state.filtered[j]]=[state.filtered[j],state.filtered[i]];}state.index=0;renderResults();renderCard();toast('Карточки перемешаны');});
  $('settings-open').addEventListener('click',()=>{refreshVoices();$('settings-dialog').showModal();});
  $('install-help').addEventListener('click',()=>{$('install-dialog').showModal();});
  $('install-open').addEventListener('click',()=>{$('install-dialog').showModal();});
  $('collection-open').addEventListener('click',openCollection);
  $('collection-apply').addEventListener('click',closeCollection);
  $('voice-select').addEventListener('change',()=>{state.voiceURI=$('voice-select').value;resetSpeech();save();});
  $('speech-rate').addEventListener('input',()=>{state.rate=Number($('speech-rate').value);$('rate-label').textContent=state.rate.toLocaleString('ru-RU')+'×';save();});
  $('export-progress').addEventListener('click',()=>{const url=URL.createObjectURL(new Blob([JSON.stringify({...progress(),exportedAt:new Date().toISOString()},null,2)],{type:'application/json'}));const a=document.createElement('a');a.href=url;a.download='englex-pocket-progress.json';a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);$('settings-status').textContent='Копия содержит ваши отметки и избранное.';});
  $('import-open').addEventListener('click',()=>$('import-progress').click());
  $('import-progress').addEventListener('change',async e=>{const file=e.target.files[0];if(!file)return;try{if(file.size>2*1024*1024)throw new Error('Файл слишком большой. Выберите копию прогресса Englex Pocket.');const p=sanitizeProgress(JSON.parse(await file.text()),new Set(byId.keys()));p.stars.forEach(id=>state.stars.add(id));Object.assign(state.ratings,p.ratings);save();applyFilters(current()?.id);$('settings-status').textContent='Прогресс добавлен. Остальные ваши отметки сохранены.';}catch(error){$('settings-status').textContent=error.message || 'Не удалось прочитать копию.';}finally{e.target.value='';}});
  document.addEventListener('keydown',e=>{if($('settings-dialog').open||$('install-dialog').open||$('collection-dialog').open||e.target.closest('input,select,textarea,button,a')||e.ctrlKey||e.metaKey||e.altKey)return;if(e.key===' '){e.preventDefault();flip();}if(e.key==='ArrowRight'){e.preventDefault();move(1);}if(e.key==='ArrowLeft'){e.preventDefault();move(-1);}if(e.key==='/'){e.preventDefault();openCollection();}});
  if(/android/i.test(navigator.userAgent))$('install-steps').replaceChildren(...['В Chrome откройте меню ⋮.','Выберите «Добавить на главный экран» или «Установить приложение».','Подтвердите добавление.'].map(text=>{const li=document.createElement('li');li.textContent=text;return li;}));
}

bindEvents();
syncPhoneLayout();syncInstalledState();
phoneMedia.addEventListener('change',syncPhoneLayout);
matchMedia('(display-mode: standalone)').addEventListener('change',syncInstalledState);
window.addEventListener('resize',scheduleCardTextFit,{passive:true});
if(typeof ResizeObserver==='function'){
  let studyWidth=-1;
  const observer=new ResizeObserver(entries=>{
    const width=entries[0].contentRect.width;
    if(width!==studyWidth){studyWidth=width;scheduleCardTextFit();}
  });
  observer.observe($('study'));
}
if(document.fonts){
  document.fonts.ready.then(scheduleCardTextFit);
  document.fonts.addEventListener('loadingdone',scheduleCardTextFit);
}
refreshVoices();updateAudioButtons();
if(speechSupported)synth.addEventListener('voiceschanged',refreshVoices);
async function init(){
  try{
    const [response,audioIndex]=await Promise.all([fetch(assetUrl('dictionary.json')),fetch(assetUrl('audio-index.json')).then(r=>r.ok?r.json():null).catch(()=>null)]);if(!response.ok)throw new Error('Не удалось загрузить словарь.');
    const data=await response.json();if(!Array.isArray(data.cards)||data.cards.length!==data.metadata.count)throw new Error('Словарь загружен не полностью.');
    metadata=data.metadata;
    state.cards=data.cards.map((c,order)=>({...c,order,search:normalizeText(`${c.word} ${c.translation} ${c.lists}`)}));
    byId=new Map(state.cards.map(c=>[c.id,c]));loadProgress();
    audioIds=new Set(Array.isArray(audioIndex?.cards)?audioIndex.cards.filter(id=>byId.has(id)):[]);
    refreshVoices();updateAudioButtons();
    $('voice-coverage').textContent=audioIds.size===state.cards.length?`AI Voice: все ${audioIds.size.toLocaleString('ru-RU')} карточки. Один мягкий голос на всех устройствах.`:audioIds.size?`AI Voice: ${audioIds.size.toLocaleString('ru-RU')} из ${state.cards.length.toLocaleString('ru-RU')} карточек. Для остальных доступна озвучка устройства.`:'Доступны английские голоса вашего устройства.';
    $('kind-filter').value=state.kind;$('sort-order').value=state.sort;$('speech-rate').value=state.rate;$('rate-label').textContent=state.rate.toLocaleString('ru-RU')+'×';
    $('source-info').textContent=`Все ${metadata.count.toLocaleString('ru-RU')} записи из вашего Englex за ${formatDate(metadata.from)}–${formatDate(metadata.through)}. Переводы сохранены из исходного словаря; транскрипция показана там, где она была в экспорте.`;
    $('collection-note').textContent=`Englex · ${formatDate(metadata.from)}–${formatDate(metadata.through)}`;
    $('load-state').hidden=true;applyFilters(currentId);refreshVoices();
  }catch(error){$('load-state').replaceChildren();const h=document.createElement('h2');h.textContent='Не удалось открыть коллекцию';const p=document.createElement('p');p.textContent='Проверьте соединение с интернетом и повторите.';const b=document.createElement('button');b.className='secondary-button';b.textContent='Попробовать ещё раз';b.addEventListener('click',()=>location.reload());$('load-state').append(h,p,b);}
}
init();
