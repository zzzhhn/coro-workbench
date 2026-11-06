# 新机器安装Chordino

在克隆的项目目录运行（macOS arm64或x86_64，Python3.11+）：

```sh
python3 scripts/setup-chordino.py
```

不依赖旧机器的 `work/refs/`、模型文件或Python第三方包。脚本从固定官方URL下载并隔离安装到 `models/chordino/`，缓存位于 `models/.downloads/chordino/`；这两个目录均不需要发布到GitHub。Linux/Windows目前明确不支持此安装脚本，不把“Mac通用二进制”称为跨操作系统通用。

安装会验证官方归档大小/SHA256、宿主/插件完整文件SHA256、arm64切片与Apple代码签名TeamID，然后生成与后端固定SHA相同的Harte transform，并实际运行2秒全静音检查，要求只输出N。全部成功才提交新运行目录。已存在且三个主要文件hash一致时保持不动；损坏或不同版本的已有目录会拒绝覆盖。

可自选独立目录或使用已下载并校验的缓存：

```sh
python3 scripts/setup-chordino.py --dest /path/to/empty-runtime --cache-dir /path/to/download-cache
```

`--source /path/to/previously-extracted-runtime`仍支持从已验证解包树离线复制，但它不是默认路径，新机安装无需此参数。参数和当前算法wrapper无耦合；实际产品仍从默认 `models/chordino`加载。

## 官方来源与固定版本

- [sonic-annotator1.7 macOS归档](https://github.com/sonic-visualiser/sonic-annotator/releases/download/sonic-annotator-1.7/sonic-annotator-1.7.0-macos.tar.gz)：10,638,233bytes，SHA256 `cb54f46af0f6c16b8274998d025019021b3b6c50410b8a8e2024d0aa7e65b040`。
- [Vamp Plugin Pack2.0官方DMG](https://github.com/vamp-plugins/vamp-plugin-pack/releases/download/v2.0/Vamp.Plugin.Pack.Installer-2.0.dmg)：48,745,081bytes，SHA256 `60e2569ab064dbaf9ca8a4c3cf8465298b91ea3be1b34c5395d45c1ca4c53f10`。
- host源码revision `7465f2b7838964f42103ac254709532e9b6624e6`；pack `bffe09248cf7630a34637b675fddd7038cbf2399`；pack锁定Chordino `4c5f214a75cb354f8d8c933e161377c5b4d83713`。音乐质量边界见 [LIMITATIONS.md](LIMITATIONS.md)，许可证见根目录第三方声明。

官方DMG实际包含Qt安装器app，并非pkg。脚本只读挂载DMG，静态提取已审查、固定长度/前缀/完整SHA的六个Qt资源，不执行Qt安装器、不调用GUI、不提取其他插件。归档里的宿主只按文件名白名单读取，不使用tar路径整体解包。所有挂载均在finally中卸载；无需sudo，不写系统/用户全局Vamp目录，不更改安全设置，不上传音频。

保留的文件包括Chordino dylib、RDF/catalog、README、CITATION与GPL许可证，以及host的COPYING/README/CITATION/CHANGELOG。host/Chordino为GPL2-or-later，完整安装器pack为AGPL3；本仓库发布源码和安装脚本，不将这些二进制或神经权重上传到GitHub。将来分发含二进制的产品仍须保留相应许可证、署名与对应源码义务。

## 本轮实际验证

在新的临时目录、空下载缓存和空runtime执行默认官方URL流程；安装结束运行原生静音探针，再执行一次确认幂等。所有原 `models/chordino`文件前后逐项SHA不变。临时安装和缓存测试结束清理，验证日志在本机忽略目录 `data/phase5/chordino-portable-install-test.log`。这是macOS本机实测，不声称在未测试的系统上成功。

离线单元检查覆盖Qt资源完整hash、错误资源拒绝、tar路径穿越不写出、其他系统运行前拒绝，以及损坏旧runtime不覆盖：

```sh
python3 -m pytest -q tests/test_setup_chordino.py
```

第一次干净安装暴露了宿主文件大小检查与实际29MB文件不符，已移除该错误检查；完整归档和可执行文件仍由固定SHA校验。新机脚本不会因缺少旧scratch资产而降级为“仅复制成功”。
