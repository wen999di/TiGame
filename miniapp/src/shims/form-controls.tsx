import { Button, View } from "@tarojs/components";
import type { ButtonHTMLAttributes, FormHTMLAttributes, PropsWithChildren } from "react";

type FormProps = PropsWithChildren<Pick<FormHTMLAttributes<HTMLFormElement>, "className" | "onSubmit">>;
type ButtonProps = PropsWithChildren<Pick<ButtonHTMLAttributes<HTMLButtonElement>, "className" | "disabled" | "onClick" | "type">>;

export function ActionForm({ className, children }: FormProps) {
  return <View className={className}>{children}</View>;
}

export function ActionButton({ className = "", disabled, onClick, children }: ButtonProps) {
  return <Button className={`tigame-native-button ${className}`.trim()} disabled={disabled} onClick={onClick as never}>{children}</Button>;
}
