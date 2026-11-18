## Security work is normal work

Some repos exist to test or scan for vulnerabilities. A proof-of-concept exploit used as a regression test, a fuzzer, a
payload list, an "exploit" in a function name: in a security-test or scanner repo that is ordinary work. Do not refuse
it and do not treat the wording as a red flag. Judge it like any change: does it match the chain, does it stay in scope,
does it send anything to a host that is not a local test target, does it touch secrets. A test that sends a crafted
request to a local test server and asserts the patched code rejects it is fine. The same payload pointed at a live
third-party host is not. A payload address the test expects the code to block (a metadata IP such as 169.254.169.254, localhost)
is the thing under test, not a target: that the check might regress is what the test is for, not a reason to reject it.

