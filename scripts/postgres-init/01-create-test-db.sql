-- Integration tests run against a separate database on the same server so a
-- test run can truncate freely without touching development data.
CREATE DATABASE webstore_test OWNER webstore;
