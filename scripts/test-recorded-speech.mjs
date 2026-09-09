import assert from 'node:assert/strict';
import {RecordedSpeech} from '../dist/recorded-speech.mjs';

const elements=[];
const timers=new Map();let nextTimer=0;
const clock={setTimeout(fn){const id=++nextTimer;timers.set(id,fn);return id;},clearTimeout(id){timers.delete(id);}};
function createAudio(){
  let reject;
  const instance={duration:1,src:'',paused:false,played:false,
    play(){this.played=true;return new Promise((_,r)=>{reject=r;});},
    pause(){this.paused=true;},removeAttribute(){this.src='';},load(){},
    reject(error){reject(error);}};
  elements.push(instance);return instance;
}
const player=new RecordedSpeech(createAudio,clock);
let firstEnded=0,secondEnded=0,errors=0;
player.play('/audio/first.mp3',{rate:.75,onFinish:()=>firstEnded++,onError:()=>errors++});
assert.equal(elements[0].played,true,'play must run synchronously in the click stack');
assert.equal(elements[0].playbackRate,.75);
assert.equal(elements[0].preservesPitch,true);
const staleEnded=elements[0].onended;
player.play('/audio/second.mp3',{onFinish:()=>secondEnded++,onError:()=>errors++});
assert.equal(firstEnded,1);
assert.equal(elements[0].paused,true);
staleEnded();elements[0].reject(new Error('Previous request aborted'));
await Promise.resolve();
assert.equal(player.job.audio,elements[1],'late events must not stop the new card');
assert.equal(errors,0);
elements[1].onended();
assert.equal(secondEnded,1);
assert.equal(player.job,null);
assert.equal(timers.size,0);

player.play('/audio/missing.mp3',{onError:()=>errors++});
const failed=elements[2];failed.onerror();failed.reject(new Error('Network failed'));
await Promise.resolve();
assert.equal(errors,1,'network and promise errors must trigger one fallback');
assert.equal(player.job,null);
player.play('/audio/retry.mp3');
assert.equal(elements[3].played,true,'an error must not lock future cards');
player.stop();

player.play('/audio/stalled.mp3',{onError:()=>errors++});
const timeout=[...timers.values()][0];timeout();
assert.equal(errors,2,'stalled loading must release the controls and fall back');
assert.equal(player.job,null);assert.equal(timers.size,0);
console.log('PASS: synchronous mobile playback, rate and pitch, card-switch races, errors, retries, and stalled loading');
