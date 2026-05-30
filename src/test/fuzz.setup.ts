import fc from 'fast-check';

const numRuns = parseInt(process.env.FC_NUM_RUNS ?? '10000', 10);

fc.configureGlobal({
  numRuns: numRuns,
  verbose: process.env.FC_VERBOSE !== 'false',
  endOnFailure: process.env.FC_END_ON_FAILURE !== 'false',
  interruptAfterTimeLimit: numRuns * 2,
  markInterruptAsFailure: true,
});
