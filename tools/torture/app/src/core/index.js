// Registry of hand-written core entry points. Every entry is a zero-argument
// function returning a value (or a Promise of one); manifest.json records the
// expected value of each, computed by running this plain source in Node (and
// in the Hermes VM when one is available).
import { closureLadder, loopCaptures, memoizedFib, counterModule } from './closures.js';
import { generatorPipeline, generatorProtocol, customIterable, labelledLoops, bigSwitch } from './iteration.js';
import { asyncLoopTryFinally, asyncParallel, asyncGenerators, asyncClosureState } from './asyncflow.js';
import { classFeatures, accessorsAndComputed, inheritanceChain } from './classes.js';
import { proxyReflect, weakCollections, symbolsAndDescriptors } from './meta.js';
import { optionalAndNullish, taggedTemplates, destructuringDefaults, spreadAndRest } from './syntax.js';
import { bigIntMath, regexNamedGroups, intlFormatting, jsonRoundTrip, collectionsMix } from './values.js';

export const CORE_ENTRIES = {
  closureLadder, loopCaptures, memoizedFib, counterModule,
  generatorPipeline, generatorProtocol, customIterable, labelledLoops, bigSwitch,
  asyncLoopTryFinally, asyncParallel, asyncGenerators, asyncClosureState,
  classFeatures, accessorsAndComputed, inheritanceChain,
  proxyReflect, weakCollections, symbolsAndDescriptors,
  optionalAndNullish, taggedTemplates, destructuringDefaults, spreadAndRest,
  bigIntMath, regexNamedGroups, intlFormatting, jsonRoundTrip, collectionsMix,
};

export const CORE_MODULES = {
  'src/core/closures.js': ['closureLadder', 'loopCaptures', 'memoizedFib', 'counterModule'],
  'src/core/iteration.js': ['generatorPipeline', 'generatorProtocol', 'customIterable', 'labelledLoops', 'bigSwitch'],
  'src/core/asyncflow.js': ['asyncLoopTryFinally', 'asyncParallel', 'asyncGenerators', 'asyncClosureState'],
  'src/core/classes.js': ['classFeatures', 'accessorsAndComputed', 'inheritanceChain'],
  'src/core/meta.js': ['proxyReflect', 'weakCollections', 'symbolsAndDescriptors'],
  'src/core/syntax.js': ['optionalAndNullish', 'taggedTemplates', 'destructuringDefaults', 'spreadAndRest'],
  'src/core/values.js': ['bigIntMath', 'regexNamedGroups', 'intlFormatting', 'jsonRoundTrip', 'collectionsMix'],
};

export async function runCore() {
  const out = {};
  for (const name of Object.keys(CORE_ENTRIES)) {
    try {
      out[name] = await CORE_ENTRIES[name]();
    } catch (e) {
      out[name] = 'THREW:' + (e && e.message);
    }
  }
  return out;
}
