/**
 * The Orchestra pet — pure ASCII frame loops, indexed by an animation tick the app
 * advances. Frames are all the same box size so swapping them never shifts layout.
 */

export const PET_IDLE: readonly string[] = [
  ' /\\_/\\ \n( o.o )\n > ^ < ',
  ' /\\_/\\ \n( o.o )\n > ^ <~',
  ' /\\_/\\ \n( -.- )\n > ^ < ', // blink
  ' /\\_/\\ \n( o.o )\n~> ^ < ',
]

export const PET_JUMP: readonly string[] = [
  '  /\\_/\\  \n≡( >.< )≡\n  > ^ <  ',
  '  /\\_/\\  \n=( >.< )=\n  > ^ <  ',
]

export const PET_PARTY: readonly string[] = [
  '\\ /\\_/\\ /\n ( ^o^ ) \n  > v <  ',
  '- /\\_/\\ -\n ( ^o^ ) \n  > v <  ',
]

/** Pick a frame for the current tick; `every` slows the loop (ticks per frame). */
export const petFrame = (frames: readonly string[], tick: number, every = 8): string =>
  frames[Math.floor(tick / every) % frames.length]
