// NovelGen 侧边栏入口(浏览器客户端 bundle)
// 格式与 DSH 官方 client 插件一致:__ModuleLoader__.load 注册工厂,
// factory 内 exports.apply/inject,由浏览器端 cordis 以插件模块方式加载。
// 作用:在侧边栏底部 footer.action 槽位注册一个「📚 小说」按钮,点击打开 /novelgen。
window.__ModuleLoader__.load({
	id: "novelgen-dsh",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		let react_jsx_runtime = require("react/jsx-runtime");

		/** 侧边栏底部按钮:宽模式显示文字,窄(rail)模式只显示图标。 */
		const NovelGenButton = (props) => {
			const wide = !!props.wide;
			return react_jsx_runtime.jsx("a", {
				href: "/novelgen",
				target: "_blank",
				rel: "noreferrer",
				title: "打开 NovelGen 小说视图(新建标签页)",
				style: {
					display: "flex",
					alignItems: "center",
					justifyContent: wide ? "flex-start" : "center",
					gap: "6px",
					height: "34px",
					width: wide ? "100%" : "34px",
					padding: wide ? "0 10px" : "0",
					borderRadius: "8px",
					color: "var(--dsw-alias-label-secondary)",
					fontSize: "13px",
					textDecoration: "none",
					cursor: "pointer",
					whiteSpace: "nowrap",
					overflow: "hidden",
					flex: "none",
					boxSizing: "border-box"
				},
				onMouseEnter: (e) => { e.currentTarget.style.background = "var(--dsw-alias-interactive-bg-hover)"; },
				onMouseLeave: (e) => { e.currentTarget.style.background = "transparent"; },
				children: wide ? "小说" : "小"
			});
		};

		const inject = ["slots"];

		function apply(ctx) {
			ctx.effect(() => ctx.slots.register({
				name: "sidebar.footer.action",
				id: "novelgen",
				label: "小说",
				order: 100
			}, NovelGenButton), "novelgen: sidebar footer action");
		}

		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	}
});
