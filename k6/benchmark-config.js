
export const benchmarkStages = [
  { duration: '30s', target: 20 },  // Ramp up
  { duration: '2m', target: 20 },  // Steady state
  { duration: '30s', target: 0 },  // Ramp down
];
export const maxVUs = 20;
