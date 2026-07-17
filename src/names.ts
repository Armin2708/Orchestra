const ADJ = ['crimson','amber','cobalt','jade','ivory','onyx','coral','silver','violet','golden','scarlet','teal','copper','indigo','pearl','slate']
const ANIMAL = ['otter','falcon','lynx','heron','badger','fox','raven','ibex','tern','marten','osprey','stoat','puffin','wolf','crane','newt']

export function generateName(rand: () => number = Math.random): string {
  const pick = (arr: string[]) => arr[Math.floor(rand() * arr.length)]
  return `${pick(ADJ)}-${pick(ANIMAL)}`
}
