<?php
/* Smarty version 3.1.32-dev-11, created on 2017-06-26 07:11:55
  from "wiki:AddThis" */

/* @var Smarty_Internal_Template $_smarty_tpl */
if ($_smarty_tpl->_decodeProperties($_smarty_tpl, array (
  'version' => '3.1.32-dev-11',
  'unifunc' => 'content_5950b3bb2755d1_77984457',
  'has_nocache_code' => false,
  'file_dependency' => 
  array (
    '2d86d516e9d9cb385ae4af6f580b0f2c58c4a712' => 
    array (
      0 => 'wiki:AddThis',
      1 => 20170623062729,
      2 => 'wiki',
    ),
  ),
  'includes' => 
  array (
  ),
),false)) {
function content_5950b3bb2755d1_77984457 (Smarty_Internal_Template $_smarty_tpl) {
?>
{{#widget:AddThis
|page_name={{PAGENAME}}
|page_url={{fullurl:{{PAGENAME}}}}
|account_id=my-account-id
|logo_url=
|logo_background=FFFFFF
|logo_color=FFFFFF
|brand=My Wiki
|options=favorites, email, digg, delicious, more
|offset_top=0
|offset_left=0
}}<?php }
}
