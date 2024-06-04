files := extension.js progressBar.js metadata.json stylesheet.css LICENSE

media-progress.zip: ${files}
	zip media-progress.zip ${files}
	gnome-extensions install media-progress.zip --force

