import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {runInNewContext} from 'node:vm';
import {test} from 'node:test';
import {normalizeText, selectCards} from '../dist/core.mjs';

const app=await readFile(new URL('../dist/app.js',import.meta.url),'utf8');
const navigation=app.slice(app.indexOf('function applyFilters('),app.indexOf('function move('));
const persistence=app.slice(app.indexOf('function progress(){'),app.indexOf('function loadProgress(){'));
const cards=[
  {id:'a',word:'study anchor',translation:'исходная карточка',lists:'',kind:'collocation',added:'2026-09-01'},
  {id:'b',word:'work',translation:'работать',lists:'',kind:'word',added:'2026-09-03'},
  {id:'c',word:'look',translation:'смотреть',lists:'',kind:'word',added:'2026-09-02'},
].map((card,order)=>({...card,order,search:normalizeText(`${card.word} ${card.translation} ${card.lists}`)}));

function setup(){
  let saved=null;
  const state={cards:[...cards],filtered:[cards[2],cards[0],cards[1]],index:1,query:'',kind:'all',sort:'newest',deck:'all',flipped:true,stars:new Set(['a']),ratings:{c:'review'},voiceURI:'auto',rate:.8};
  const context={state,searchBookmark:null,currentId:'a',normalizeText,selectCards,VOICE_PREFERENCE_VERSION:3,STORAGE_KEY:'englex-pocket-v1',storageWarning:false,
    current:()=>state.filtered[state.index]||null,renderResults(){},updateCounts(){},toast:()=>assert.fail('storage failed'),
    localStorage:{setItem(key,value){assert.equal(key,'englex-pocket-v1');saved=JSON.parse(value);}},
    flip(value){state.flipped=value;},renderCard(){const card=context.current();if(card){context.currentId=card.id;state.flipped=false;context.save();}}
  };
  runInNewContext(persistence+navigation,context);
  return {state,context,query:value=>context.setSearchQuery(value),saved:()=>saved};
}

test('searching, picking another result and clearing restores the study card, shuffled order and reverse side',()=>{
  const {state,context,query,saved}=setup();
  query('work');assert.equal(context.current().id,'b');assert.equal(saved().currentId,'a','search must not overwrite the stored study position');
  query('look');assert.equal(context.current().id,'c');assert.equal(saved().currentId,'a');
  query('');assert.equal(context.current().id,'a');assert.deepEqual(state.filtered.map(c=>c.id),['c','a','b']);assert.equal(state.flipped,true);
  assert.equal(saved().currentId,'a');assert.deepEqual(saved().stars,['a']);assert.deepEqual(saved().ratings,{c:'review'});assert.equal(saved().voiceURI,'auto');assert.equal(saved().rate,.8);
});

test('no results and whitespace-only clearing return to the bookmark; a later search takes a new bookmark',()=>{
  const {state,context,query}=setup();
  query('not-in-this-dictionary');assert.equal(state.filtered.length,0);
  query('   ');assert.equal(context.current().id,'a');
  state.index=2;context.renderCard();query('look');query('');assert.equal(context.current().id,'b');
  const before=state.filtered;query(' ');assert.equal(state.filtered,before,'empty input must not reset an unsearched shuffled deck');
});

test('searching and navigating results saves the original position for reload and progress export',()=>{
  const {state,context,query,saved}=setup();
  query('o');state.index=1;context.renderCard();
  assert.equal(saved().currentId,'a');assert.equal(context.progress().currentId,'a');
  // The app does not persist the transient query; this saved ID restores normal study.
  const restored=selectCards(state.cards,{...state,query:''});
  assert.ok(restored.some(card=>card.id===saved().currentId));
});

test('dictionary refresh during a search retains new cards without resurrecting removed cards',()=>{
  const {state,context,query}=setup();
  query('work');
  const extra={id:'d',word:'new work',translation:'',lists:'',kind:'collocation',added:'2026-09-04',order:3,search:'new work'};
  state.cards=[...state.cards.filter(card=>card.id!=='c'),extra];
  context.applyFilters('b');query('');
  assert.equal(context.current().id,'a');assert.deepEqual(state.filtered.map(card=>card.id),['a','b','d']);
});

test('explicit changes to filters or sorting remain in force on return; excluded anchors use a valid card',()=>{
  const {state,context,query}=setup();
  query('work');state.kind='word';state.sort='alphabetical';context.applyFilters();query('');
  assert.deepEqual(state.filtered.map(card=>card.id),['c','b']);assert.equal(context.current().id,'c');assert.equal(state.kind,'word');assert.equal(state.sort,'alphabetical');
  assert.equal(state.flipped,false,'do not apply the old reverse side to another card');
});

test('a review or starred card removed while searching does not reappear through the bookmark',()=>{
  const {state,context,query}=setup();
  state.deck='starred';state.stars.add('b');state.filtered=[cards[0],cards[1]];state.index=0;
  query('work');state.stars.delete('a');query('');
  assert.deepEqual(state.filtered.map(card=>card.id),['b']);assert.equal(context.current().id,'b');
});
