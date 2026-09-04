/**
 * RSA key pair used **only** by the end-to-end suite.
 *
 * Not a secret and not a credential for anything: it exists so the e2e run can
 * mint a token the web app will verify, exactly as a real identity provider
 * would. It is never referenced outside `e2e/`, never bundled, and the
 * deployment reads its own key material from `AUTH_JWT_*`.
 */
export const TEST_PUBLIC_KEY_PEM = `-----BEGIN PUBLIC KEY-----
MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAvc54mEzK5826/Qksnm62
lk70jE4KZbK7ENRMmzUInxU628lSLgXtO71UfIwvD2D+d3iet/fS7SrLtltlKmSP
hfSoU4vHcXfn87tp1btlwRm/Ql8NWoJzKu2WAYpdCQo7IDId9pUhn4hzY+c5BjFa
sHVq+eXRt/2bdOSI0X6ZJKUQ8pAfJ0bwQss+RxXQaGQOz/uqNdDjkBF/2C9eoAMN
Kt9lwAimjjNlB+kbAvzG4bBO836ZivLVGPmFwkQgmHGvABMIKLNT4n0bN/okktRM
4ZnqgONYF6JZVjVXXzMkeEKItowY4mYuxj1HPz5pksPm7d2TqJSOpdTLuCkHGn+K
IwIDAQAB
-----END PUBLIC KEY-----`;

export const TEST_PRIVATE_KEY_PEM = `-----BEGIN PRIVATE KEY-----
MIIEvAIBADANBgkqhkiG9w0BAQEFAASCBKYwggSiAgEAAoIBAQC9zniYTMrnzbr9
CSyebraWTvSMTgplsrsQ1EybNQifFTrbyVIuBe07vVR8jC8PYP53eJ6399LtKsu2
W2UqZI+F9KhTi8dxd+fzu2nVu2XBGb9CXw1agnMq7ZYBil0JCjsgMh32lSGfiHNj
5zkGMVqwdWr55dG3/Zt05IjRfpkkpRDykB8nRvBCyz5HFdBoZA7P+6o10OOQEX/Y
L16gAw0q32XACKaOM2UH6RsC/MbhsE7zfpmK8tUY+YXCRCCYca8AEwgos1PifRs3
+iSS1EzhmeqA41gXollWNVdfMyR4Qoi2jBjiZi7GPUc/PmmSw+bt3ZOolI6l1Mu4
KQcaf4ojAgMBAAECggEAIZh6H/r3ry/q+P62txRBnTk8b9kgXf/UvJXXOWGZtQ68
7EomEZ9a7kgEvEbTzZUNdXgUH9vtqaz5gb2LmoVSIhO79422L49ZrvptMTeKOzOj
dsv8QRj16ZNECeHDteXpsTkttIeQ+/va8MPsg/wYYUNnO/RBup9Y9Me+r9YIpUOE
OwtZsZN+PCS2CMOj007sIOSwdJHgHQgHIuc7XAB5mbZfvjj2TMxt+GoyEYKcAy1m
TdJTNGxH6zmeAQDraIlOFKYH+9gDTOct92Hq8z3icqnMsOTX7H250EnyC/1yEiCr
v5OUW9DxfsOcVF5tsyKv+LyZlPF9ISLbyQkfYrJwAQKBgQDjBw3wtd6skwBycA1X
jPxv3gQOTLM1k3qUmn0QytpQxEp28AYTDTyUPAymmaezw4iB5UHBK/vuOf9vvpem
/wrkmCFrXbKQH1tG7yWEbpdZivqTLy8k3Y6tWXfuVnqEtj4Y1x1ZObPFYPvCEfaM
Y2i2ILSEN4sfG1U1BO784qh1gQKBgQDWB2m2dKW1ZN6FoMt14P5okkIVhubYYhqI
1kXwir8IzKEVMwo+ob4U1qCMhGsFknjOOGtupOPqPIPyHdO/qHsf5vhlUHnl55+l
tOH99AVjQpQOWAahuAKVbrWXKN1jvV3RrU6Hh2NgOKb4HMzwN9J4lRe1A1SZ2wGZ
Qy9CzpM5owKBgBISgLCVubkhJpr1gopipcG9+bKttmJgcBSeS7BnhYOCbK8VIlan
6heexB8LAkeUHCzC9D4NY0uugEAD+wyHJvXVimuClPFWHa0C4oitSQ0OvC21Rtp3
bKEuCxcE+VHRNBZEIYj1x/LBaqkjRu4cB7zf057m0QNT6K+EygWFgYWBAoGAe3qX
YK53k+l3//w+pemCnW4UNjs4H4qp6FxGyXoisL7uCD8EIBJMidUxlyAmZnaUv9UJ
FjKHU3JKZXsT2TUoo8UrdbgyO5OgJYfwAgWwvg2BQa1DVjXFN9VBas4mvA5afEfS
UJqpmK/WlLp4+fYatXq+zK35NzKE/5klQRPRGKUCgYAgFd8e0gAvFgtrNWC85FUk
Gm1/xuJbpkP5acm8OfjCrl4Jnk3kBGNbdCIk5XiTeRLN5+LLlKuJ/nUWXzc2wSCZ
o6A+RrmJEQx+RLYXq3Lp34e/mOnN4JgksVqcQDzz458tWWXlNHtAHwAW8Kpe8a9o
y0R5hddyeHCjBGJkQeHfbA==
-----END PRIVATE KEY-----`;

export const TEST_ISSUER = 'https://auth.e2e.local';
export const TEST_AUDIENCE = 'audiobook-api-e2e';
