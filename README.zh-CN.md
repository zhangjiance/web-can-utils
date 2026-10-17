# Web CAN Utils

[English](README.md) | 简体中文

基于浏览器的 CAN/CAN FD 监控与发送工具。通过 WebUSB 直接连接兼容 GS_USB /
Candlelight 协议的适配器，无需安装驱动或原生应用。

**在线演示：** <https://zhangjiance.github.io/web-can-utils/>

## 功能

- 通过 WebUSB 支持 GS_USB / Candlelight 适配器
- 多通道 CAN 与 CAN FD 监控
- 支持周期发送任务的发送面板
- 总线时序预设与自定义位时序寄存器
- 硬件时间戳、错误帧、终端电阻控制与调试日志
- 响应式深色/浅色界面

## 本地运行

通过 HTTP 提供本目录，并使用支持 WebUSB 的浏览器（Chrome 或 Edge）打开
`index.html`：

```sh
python3 -m http.server 8000
# http://localhost:8000/
```

WebUSB 要求页面运行在 `localhost` 或 HTTPS 下。

## 测试

```sh
npm install
npm test
```

`test_gsusb.mjs` 使用模拟的 WebUSB 设备测试适配器，无额外依赖；
`uitest.mjs` 使用 jsdom 驱动真实界面进行测试。

## 许可证

Apache-2.0，详见 [LICENSE](LICENSE)。
