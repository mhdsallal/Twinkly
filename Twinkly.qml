Item {
    anchors.fill: parent

    Column{
        width: parent.width
        height: parent.height
        spacing: 10

		Rectangle{
			id: scanningItem
			height: 100
			width: childrenRect.width + 15
			visible: service.controllers.length === 0
			color: theme.background3
			radius: theme.radius

			BusyIndicator {
				id: scanningIndicator
				height: 30
				anchors.verticalCenter: parent.verticalCenter
				width: parent.height
				Material.accent: "#88FFFFFF"
				running: scanningItem.visible
			}  

			Column{
				width: childrenRect.width
				anchors.left: scanningIndicator.right
				anchors.verticalCenter: parent.verticalCenter

				Text{
					color: theme.secondarytextcolor
					text: "Searching network for Twinkly Devices..." 
					font.pixelSize: 14
					font.family: "Montserrat"
				}
				Text{
					color: theme.secondarytextcolor
					text: "This may take several minutes..." 
					font.pixelSize: 14
					font.family: "Montserrat"
				}
			}
		}
    
        Repeater{
            model: service.controllers          

            delegate: Item {
                id: root
                width: 250
                height: content.height
                property var device: model.modelData.obj

                Rectangle {
                    width: parent.width
                    height: parent.height
                    color: Qt.lighter(theme.background2, 1.3)
                    radius: 5
                }

                Column{
                    id: content
                    width: parent.width
                    padding: 10
                    spacing: 5

                    Row{
                        width: parent.width
                        height: childrenRect.height

                        Column{
                            id: leftCol
                            width: 250
                            height: childrenRect.height
                            spacing: 2

                            Text{
                                color: theme.primarytextcolor
                                text: device.name
                                font.pixelSize: 16
                                font.family: "Poppins"
                                font.weight: Font.Bold
                            }

                            Text{
                                color: theme.secondarytextcolor
                                text: "ID: " + device.id
                            }

                            Text{
                                color: theme.secondarytextcolor
                                text: "IP Address: " + (device.ip != "" ? device.ip : "Unknown")
                            }
                        }
                    }
                }
            }  
        }

		Rectangle {
            width: 250
            height: 110
            color: Qt.lighter(theme.background2, 1.3)
            radius: 5

			Column{
				spacing: 5
				anchors.horizontalCenter: parent.horizontalCenter
				anchors.verticalCenter: parent.verticalCenter
				
            	Label{
            	    text: "Force Discovery Using IP Address: "
            	    color: theme.primarytextcolor
		    		font.family: "Poppins"
		    		font.bold: true
		    		font.pixelSize: 13
            	}

            	Rectangle {
				width: 230
				height: 35
				radius: 5
				border.color: "#1c1c1c"
				border.width: 1
				anchors.horizontalCenter: parent.horizontalCenter
				color: Qt.lighter(theme.background1, 1.3)
			    	TextField {
			    		width: 180
			    		leftPadding: 10
			    		rightPadding: 10
			    		id: discoverIP
			    		color: theme.secondarytextcolor
			    		font.family: "Poppins"
			    		font.pixelSize: 15
			    		verticalAlignment: Text.AlignHCenter
			    		placeholderText: "IP Address"
			    		onEditingFinished: {
			    			discovery.forceDiscover(discoverIP.text);
			    		}
			    		validator: RegularExpressionValidator {
			    			regularExpression:  /^((?:[0-1]?[0-9]?[0-9]|2[0-4][0-9]|25[0-5])\.){0,3}(?:[0-1]?[0-9]?[0-9]|2[0-4][0-9]|25[0-5])$/
			    		}
			    		background: Item {
			    			width: parent.width
			    			height: parent.height
			    			Rectangle {
			    				color: "transparent"
			    				height: 1
			    				width: parent.width
			    				anchors.bottom: parent.bottom
			    			}
			    		}
			    	}
				}
				Rectangle {
					width: 230
					height: 30
					radius: 5
					border.color: "#1c1c1c"
					border.width: 1
					anchors.horizontalCenter: parent.horizontalCenter
					color: Qt.lighter(theme.background3, 1.3)
					ToolButton {
						height: 30
						width: 230
						font.family: "Poppins"
						font.capitalization: Font.MixedCase
						text: "Purge IP Cache"
						
						onClicked: {
							discovery.purgeIPCache();
						}
						ToolTip.visible: hoverMouseArea.containsMouse;
    					ToolTip.text: qsTr("Purge the list of saved IP's. Only do this if you are having issues.");
						
						MouseArea {
							id: hoverMouseArea
							anchors.fill: parent
							hoverEnabled: true
						}
					}
				}
        	}
        }
        
    }
}