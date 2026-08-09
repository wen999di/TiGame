import type { PropsWithChildren } from "react";
import "./platform";
import "@tarojs/taro/html.css";
import "../../app/shared.css";
import "./miniapp.css";
import "./layout.css";

export default function App({ children }: PropsWithChildren) {
  return children;
}
