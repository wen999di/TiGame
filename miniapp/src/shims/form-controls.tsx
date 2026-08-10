import { Button, Text, View } from "@tarojs/components";
import { Children, isValidElement, type ButtonHTMLAttributes, type FormHTMLAttributes, type PropsWithChildren, type ReactNode } from "react";

type FormProps = PropsWithChildren<Pick<FormHTMLAttributes<HTMLFormElement>, "className" | "onSubmit">>;
type ButtonProps = PropsWithChildren<Pick<ButtonHTMLAttributes<HTMLButtonElement>, "className" | "disabled" | "onClick" | "type">>;

function nativeButtonChildren(children: ReactNode): ReactNode {
  return Children.map(children, (child) => {
    if (typeof child === "string" || typeof child === "number") {
      return <Text>{String(child)}</Text>;
    }
    if (isValidElement<{ className?: string; children?: ReactNode }>(child) && child.type === "span") {
      return <Text className={child.props.className}>{nativeButtonChildren(child.props.children)}</Text>;
    }
    return child;
  });
}

export function ActionForm({ className, children }: FormProps) {
  return <View className={className}>{children}</View>;
}

export function ActionButton({ className = "", disabled, onClick, children }: ButtonProps) {
  return (
    <Button className={`tigame-native-button ${className}`.trim()} disabled={disabled} onClick={onClick as never}>
      {nativeButtonChildren(children)}
    </Button>
  );
}

export { MiniProfileEditor } from "./MiniProfileEditor";
