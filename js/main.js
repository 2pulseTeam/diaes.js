define.amd.jQuery = true;

requirejs.config({
	baseUrl: 'js/lib',
	paths: {
		app: '../app'
	},
	urlArgs: "bust=" + (new Date()).getTime()
});

requirejs(
	['diaes'],

	function (Diaes) {
		window.Diaes = Diaes;
	}
);