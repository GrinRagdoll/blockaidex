# Standard Operating Procedure: VPN Setup

**Service:** Cisco AnyConnect Secure Mobility Client 5.1  
**Audience:** Employees with an approved remote-access request  
**Connection:** Organization VPN gateway over TCP port 443

## Purpose and access approval

This procedure describes how to install and connect to the organization VPN. VPN access is granted only for an approved business need. Obtain manager approval and an IT-approved access request before installing or connecting. IT must confirm that the account is enabled and provide the official VPN gateway address. Do not use a gateway address supplied by an unverified source.

## Prerequisites

- A supported, company-managed computer with current operating-system updates.
- An approved VPN access request and active company account.
- Cisco AnyConnect Secure Mobility Client version 5.1 from the company software portal or IT.
- The VPN gateway address provided through an approved IT channel.
- A working internet connection and your company MFA method.

## Installation and connection

1. Confirm the access request is approved. Contact the service desk if it is not or the VPN option is unavailable.
2. Install Cisco AnyConnect Secure Mobility Client 5.1 using the company software portal or the installer provided by IT. Do not download installers from third-party sites.
3. Open AnyConnect and enter the approved VPN gateway address. Select **Connect**.
4. If prompted, sign in with your company username and password, then complete MFA using your registered method. Never approve an MFA prompt you did not initiate.
5. Verify the client reports **Connected** and that company resources load as expected.
6. When finished, disconnect from the VPN in AnyConnect. Close the client when it is no longer needed.

The standard VPN connection uses TCP port 443. Do not change firewall settings or configure alternate ports yourself. If the network blocks the connection, ask IT to review it.

## Troubleshooting: Error 412

Error 412 indicates that the VPN peer stopped responding or the connection was interrupted.

1. Confirm the device still has internet access by opening an approved public site.
2. Disconnect in AnyConnect, wait briefly, and reconnect to the IT-provided gateway.
3. Check that the device date and time are set automatically and are correct.
4. If you are on a restricted guest, hotel, or public network, complete its captive-portal sign-in first or try another trusted network.
5. Restart AnyConnect and the computer if the error continues. Do not disable endpoint protection or bypass certificate warnings.
6. Contact the IT service desk if repeated attempts fail. Include the exact error text, time, network type, AnyConnect version, and a screenshot with credentials and sensitive information removed.

IT should verify the account approval, gateway availability, and TCP 443 reachability. Escalate persistent failures with the client logs collected using the organization's approved support process.

## Security and support

Do not share passwords, MFA codes, or VPN configuration files. Report an unexpected MFA prompt or suspected account compromise to IT immediately. VPN access may be removed when the business need ends or the account is no longer eligible.
