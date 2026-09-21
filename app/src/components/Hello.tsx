import { useGreeting } from '../hooks/useGreeting'

export interface HelloProps {
  /** Who to greet. Blank falls back to "world". */
  name: string
}

export function Hello({ name }: HelloProps) {
  const greeting = useGreeting(name)
  return <p>{greeting}</p>
}
