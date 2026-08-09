import type { ButtonHTMLAttributes, FormHTMLAttributes } from "react";

export function ActionForm(props: FormHTMLAttributes<HTMLFormElement>) {
  return <form {...props} />;
}

export function ActionButton(props: ButtonHTMLAttributes<HTMLButtonElement>) {
  return <button {...props} />;
}
