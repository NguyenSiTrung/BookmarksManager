import { fireEvent, screen } from "@testing-library/react";

/** Radix dropdown triggers open on pointerdown; jsdom needs the explicit event. */
export async function openMenu(name: string | RegExp): Promise<void> {
  fireEvent.pointerDown(screen.getByRole("button", { name }), {
    button: 0,
    ctrlKey: false,
  });
  await screen.findByRole("menu");
}

/** Click one item of the currently open menu. */
export async function chooseMenuItem(name: string | RegExp): Promise<void> {
  fireEvent.click(await screen.findByRole("menuitem", { name }));
}
