#!/bin/bash

echo "Installing upc search Dependencies"
sudo apt-get update
# Install the required packages via apt-get
sudo apt-get -y install

echo "Installing fuzzy-search"
npm install fuzzy-search save

# If you need to differentiate install for armhf and i386 you can get the variable like this
#DPKG_ARCH=`dpkg --print-architecture`
# Then use it to differentiate your install

#requred to end the plugin install
echo "plugininstallend"
