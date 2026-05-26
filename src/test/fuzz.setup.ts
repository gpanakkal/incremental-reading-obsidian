import fc from 'fast-check';

fc.configureGlobal({
  numRuns: parseInt(process.env.FC_NUM_RUNS ?? '10000', 10),
  verbose: process.env.FC_VERBOSE !== 'false',
  endOnFailure: process.env.FC_END_ON_FAILURE !== 'false',
});
