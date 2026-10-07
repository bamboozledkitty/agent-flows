-- Opens a new iTerm window and types one command into it.
-- Agent Flows runs this as: osascript open-iterm.applescript "<command>"
on run argv
	tell application "iTerm"
		create window with default profile
		tell current session of current window to write text (item 1 of argv)
	end tell
end run
