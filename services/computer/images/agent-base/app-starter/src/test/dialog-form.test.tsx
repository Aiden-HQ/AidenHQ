// The pattern to copy for a component test: render with Testing Library, act as a person with user-event (click, type,
// keyboard), and find things by role and label. Portalled pieces (Dialog, Sheet, Select, Popover) work as in a browser.
import { useState } from "react"
import { expect, test } from "bun:test"
import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogDescription, DialogTitle, DialogTrigger } from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"

function NewItem({ onSave }: { onSave: (item: { name: string; status: string }) => void }) {
  const [open, setOpen] = useState(false)
  const [status, setStatus] = useState("on-track")
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild><Button>New item</Button></DialogTrigger>
      <DialogContent>
        <DialogTitle>New item</DialogTitle>
        <DialogDescription>Name it and pick its status.</DialogDescription>
        <form onSubmit={(e) => { e.preventDefault(); onSave({ name: String(new FormData(e.currentTarget).get("name")), status }); setOpen(false) }}>
          <Label htmlFor="name">Name</Label>
          <Input id="name" name="name" />
          <Select value={status} onValueChange={setStatus}>
            <SelectTrigger aria-label="Status"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="on-track">On track</SelectItem>
              <SelectItem value="at-risk">At risk</SelectItem>
            </SelectContent>
          </Select>
          <Button type="submit">Save</Button>
        </form>
      </DialogContent>
    </Dialog>
  )
}

test("a dialog opens, takes a name and a status, saves and closes", async () => {
  const user = userEvent.setup()
  const saved: { name: string; status: string }[] = []
  render(<NewItem onSave={(item) => saved.push(item)} />)

  await user.click(screen.getByRole("button", { name: "New item" }))
  expect(screen.getByRole("dialog", { name: "New item" })).toBeTruthy()
  await user.type(screen.getByLabelText("Name"), "Lamp")
  await user.click(screen.getByRole("combobox", { name: "Status" }))
  await user.click(await screen.findByRole("option", { name: "At risk" }))
  await user.click(screen.getByRole("button", { name: "Save" }))

  expect(saved).toEqual([{ name: "Lamp", status: "at-risk" }])
  expect(screen.queryByRole("dialog")).toBeNull()
})

test("Escape closes the dialog without saving", async () => {
  const user = userEvent.setup()
  const saved: unknown[] = []
  render(<NewItem onSave={(item) => saved.push(item)} />)
  await user.click(screen.getByRole("button", { name: "New item" }))
  await user.keyboard("{Escape}")
  expect(screen.queryByRole("dialog")).toBeNull()
  expect(saved).toEqual([])
})
