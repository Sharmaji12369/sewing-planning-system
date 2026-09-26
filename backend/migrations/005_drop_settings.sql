-- The planning controls are gone: pace averages every worked day, the week is
-- fixed at Mon-Sat (exceptions are idle days), and "plan as of" is chosen per
-- viewer in the page, defaulting to today. Nothing reads this table any more.

DROP TABLE IF EXISTS settings;
