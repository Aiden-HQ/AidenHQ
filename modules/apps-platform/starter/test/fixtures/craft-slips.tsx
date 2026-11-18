export function Slips({ go }: { go: () => void }) {
  return (
    <div>
      <div onClick={go}>Open</div>
      <span onClick={go} role="button" onKeyDown={go}>Fine</span>
      <p className="transition-all outline-none scale-0">Slips</p>
      <p className="hover:scale-[0.97] focus-visible:ring-2 outline-none focus-visible:outline-none transition-colors">Fine</p>
    </div>
  )
}
