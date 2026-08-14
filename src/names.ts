const ADJ = ['crimson','amber','cobalt','jade','ivory','onyx','coral','silver','violet','golden','scarlet','teal','copper','indigo','pearl','slate']
const ANIMAL = ['otter','falcon','lynx','heron','badger','fox','raven','ibex','tern','marten','osprey','stoat','puffin','wolf','crane','newt']

export function generateName(rand: () => number = Math.random): string {
  const pick = (arr: string[]) => arr[Math.floor(rand() * arr.length)]
  return `${pick(ADJ)}-${pick(ANIMAL)}`
}

/** Test-pass agents are named for the job, not with a colour-animal, so the board reads
    "who is testing this" at a glance. Lowercase-hyphen to stay a legal agent name (env,
    `--from`, rename validation all take `[a-z0-9-]{1,32}`). */
export const TESTER_NAME = 'tester-agent'

/** Reuses the retired tester row whenever it is free — a suffix only appears while a
    previous tester is still live, which the serial verify queue makes rare. */
export function testerName(taken: (name: string) => boolean): string {
  if (!taken(TESTER_NAME)) return TESTER_NAME
  for (let n = 2; n <= 99; n++) if (!taken(`${TESTER_NAME}-${n}`)) return `${TESTER_NAME}-${n}`
  return `${TESTER_NAME}-${generateName()}`
}
