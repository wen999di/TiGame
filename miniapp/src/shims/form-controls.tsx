import { Button, View } from "@tarojs/components";
import Taro from "@tarojs/taro";
import type { ButtonHTMLAttributes, FormHTMLAttributes, PropsWithChildren } from "react";

declare const __TIGAME_MINIAPP_DEBUG__: boolean;

type FormProps = PropsWithChildren<Pick<FormHTMLAttributes<HTMLFormElement>, "className" | "onSubmit">>;
type ButtonProps = PropsWithChildren<Pick<ButtonHTMLAttributes<HTMLButtonElement>, "className" | "disabled" | "onClick" | "type">>;

export function ActionForm({ className, children }: FormProps) {
  return <View className={className}>{children}</View>;
}

export function ActionButton({ className = "", disabled, onClick, children }: ButtonProps) {
  const handleClick = (event: unknown) => {
    if (__TIGAME_MINIAPP_DEBUG__) {
      void Taro.showToast({ title: "点击已收到", icon: "none", duration: 800 });
    }
    onClick?.(event as never);
  };
  return <Button className={`tigame-native-button ${className}`.trim()} disabled={disabled} onClick={handleClick as never}>{children}</Button>;
}
