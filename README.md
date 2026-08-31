# PingMap

A small GitHub Pages app for walking around with two phones and recording GPS coordinates plus HTTP latency once per second.

## Publish

1. Push these files to the repository's default branch.
2. On GitHub, open **Settings → Pages**.
3. Under **Build and deployment**, choose **Deploy from a branch**, select the default branch and `/ (root)`, then save.
4. Open the resulting `https://USERNAME.github.io/REPOSITORY/` URL on each phone.

On each phone, enter a label, such as `iPhone - Carrier A`, tap **Start test**, and allow location access. Keep the page open and the screen awake. Tap **Export CSV** when finished.

The default endpoint is `ping.txt` on the same GitHub Pages site. This measures HTTP round-trip time to GitHub Pages; it is not a raw ICMP ping. No data is uploaded by this basic version.
